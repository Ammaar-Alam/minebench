import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import {
  findCatalogEntryBySlugOrKey,
  type ModelCatalogEntry,
} from "@/lib/ai/modelCatalog";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getArenaArtifactCoverage } from "@/lib/arena/artifactCoverage";
import { normalizeArenaBuildChecksum } from "@/lib/arena/buildChecksum";
import { arenaCohortBuildWhere } from "@/lib/arena/eligibility";
import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";
import {
  databaseIdentityFromUrl,
  isSameDatabaseTarget,
  supabaseProjectRefFromApiUrl,
} from "@/lib/db/identity";
import { prisma } from "@/lib/prisma";
import { parseVoxelBuildSpec } from "@/lib/voxel/validate";

// Model publication: upload the benchmark cohort, run the artifact maintenance
// primitives missing-only, verify policy-aware coverage, refresh metrics, then
// activate the model. Each step is an existing CLI so publication adds
// orchestration, not a second implementation.

const require = createRequire(import.meta.url);

export type PublicationStepResult = {
  name: string;
  command: string[];
  ranFor: "real" | "dry-run" | "skipped";
  exitCode: number | null;
};

export type ModelPublicationLock = {
  assertHeld: () => Promise<void>;
  release: () => Promise<void>;
};

const PUBLICATION_LOCK_NAMESPACE = "minebench:model-publish";

export function resolvePublicationLockDatabaseUrl(
  databaseUrl = process.env.DATABASE_URL,
  directUrl = process.env.DIRECT_URL,
): string {
  const runtimeUrl = databaseUrl?.trim() || directUrl?.trim();
  const lockUrl = directUrl?.trim() || runtimeUrl;
  if (!runtimeUrl || !lockUrl) {
    throw new Error("Missing DATABASE_URL for publication locking");
  }

  const runtimeIdentity = databaseIdentityFromUrl(runtimeUrl);
  const lockIdentity = databaseIdentityFromUrl(lockUrl);
  if (!runtimeIdentity || !lockIdentity) {
    throw new Error("Could not parse the publication lock database target");
  }
  if (!isSameDatabaseTarget(runtimeIdentity, lockIdentity)) {
    throw new Error("DIRECT_URL points at a different database target than DATABASE_URL");
  }

  const parsed = new URL(lockUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const supabaseHost = /\.supabase\.(co|com|net)$/.test(hostname);
  if (
    (supabaseHost && parsed.port === "6543") ||
    parsed.searchParams.get("pgbouncer")?.toLowerCase() === "true"
  ) {
    throw new Error(
      "DIRECT_URL must use a direct or session-affine PostgreSQL connection for publication locking",
    );
  }
  parsed.searchParams.set("connection_limit", "1");
  return parsed.toString();
}

export async function acquireModelPublicationLock(
  modelKey: string,
): Promise<ModelPublicationLock> {
  const client = new PrismaClient({
    datasourceUrl: resolvePublicationLockDatabaseUrl(),
  });
  await client.$connect();

  let backendPid: number;
  try {
    const [row] = await client.$queryRaw<Array<{ locked: boolean; backendPid: number }>>`
      SELECT
        pg_try_advisory_lock(
          hashtext(${PUBLICATION_LOCK_NAMESPACE}),
          hashtext(${modelKey})
        ) AS "locked",
        pg_backend_pid() AS "backendPid"
    `;
    if (!row?.locked) {
      throw new Error(`Another publication is already running for model '${modelKey}'`);
    }
    backendPid = row.backendPid;
  } catch (error) {
    await client.$disconnect().catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    async assertHeld() {
      if (released) throw new Error("Publication lock has already been released");
      const [row] = await client.$queryRaw<Array<{ backendPid: number }>>`
        SELECT pg_backend_pid() AS "backendPid"
      `;
      if (row?.backendPid !== backendPid) {
        throw new Error("Publication lock connection was lost; aborting publication");
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        const [row] = await client.$queryRaw<
          Array<{ unlocked: boolean; backendPid: number }>
        >`
          SELECT
            pg_advisory_unlock(
              hashtext(${PUBLICATION_LOCK_NAMESPACE}),
              hashtext(${modelKey})
            ) AS "unlocked",
            pg_backend_pid() AS "backendPid"
        `;
        if (!row?.unlocked || row.backendPid !== backendPid) {
          throw new Error("Publication lock was not owned by its original database session");
        }
      } finally {
        await client.$disconnect().catch(() => undefined);
      }
    },
  };
}

export type PublicationReport = {
  modelKey: string;
  steps: PublicationStepResult[];
  verification: Awaited<ReturnType<typeof getArenaArtifactCoverage>> | null;
  activated: boolean;
};

export type PublicationStageState = "missing" | "already-staged" | "staged";

type PublicationCohortArtifact = {
  promptSlug: string;
  promptText: string;
  voxelSha256: string;
};

function publicationAdminHeaders(token: string): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return {
    Authorization: `Bearer ${token}`,
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
  };
}

// Exactly one canonical key or slug; substring matching is not accepted here
export function resolvePublicationModel(value: string): ModelCatalogEntry {
  const entry = findCatalogEntryBySlugOrKey(value);
  if (!entry) {
    throw new Error(`Unknown model key or slug: '${value}'. Pass the exact catalog key or slug.`);
  }
  if (!entry.enabled && !entry.importOnly) {
    throw new Error(`Model '${value}' is retired in the catalog and cannot be published.`);
  }
  // import-only models cannot be generated through provider APIs, but their
  // supplied cohort still has to be uploaded, verified, and activated, and
  // publication is the only path that activates anything
  return entry;
}

// The benchmark cohort files that must exist locally before publication
function cohortArtifactPath(
  entry: ModelCatalogEntry,
  promptSlug: string,
  uploadsDir: string,
): string {
  return path.join(uploadsDir, promptSlug, `${promptSlug}-${entry.slug}.json`);
}

export function missingCohortArtifacts(
  entry: ModelCatalogEntry,
  promptSlugs: readonly string[],
  uploadsDir: string,
): string[] {
  return promptSlugs
    .map((promptSlug) => cohortArtifactPath(entry, promptSlug, uploadsDir))
    .filter((filePath) => {
      try {
        return !fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0;
      } catch {
        return true;
      }
    });
}

export function publicationArtifactChecksum(
  bytes: Buffer,
  representation: "inline" | "storage",
): string {
  if (representation === "storage") {
    return createHash("sha256").update(bytes).digest("hex");
  }

  const payload = extractBestVoxelBuildJson(bytes.toString("utf8"));
  if (!payload) throw new Error("Build file does not contain a valid JSON object");
  const spec = parseVoxelBuildSpec(payload);
  if (!spec.ok) throw new Error(spec.error);
  return createHash("sha256").update(JSON.stringify(spec.value)).digest("hex");
}

export function publicationArtifactRepresentation(build: {
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
}): "inline" | "storage" {
  return build.voxelStorageBucket && build.voxelStoragePath ? "storage" : "inline";
}

export function findChangedPublicationPromptSlugs(
  existingBuilds: readonly { promptText: string; voxelSha256: string | null }[],
  incomingBuilds: readonly PublicationCohortArtifact[],
): string[] {
  const existingChecksums = new Map(
    existingBuilds.map((build) => [
      build.promptText,
      normalizeArenaBuildChecksum(build.voxelSha256)?.toLowerCase() ?? null,
    ]),
  );
  return incomingBuilds
    .filter(
      (build) => existingChecksums.get(build.promptText) !== build.voxelSha256.toLowerCase(),
    )
    .map((build) => build.promptSlug);
}

export async function assertRatedModelCohortUnchanged(
  entry: ModelCatalogEntry,
  promptSlugs: readonly string[],
  uploadsDir: string,
): Promise<void> {
  const model = await prisma.model.findUnique({
    where: { key: entry.key },
    select: { id: true },
  });
  if (!model) return;

  const votedMatchups = await prisma.matchup.count({
    where: {
      OR: [{ modelAId: model.id }, { modelBId: model.id }],
      votes: { some: {} },
    },
  });
  if (votedMatchups === 0) return;

  const publicationPrompts = promptSlugs.map((promptSlug) => {
    const promptText = BENCHMARK_PROMPT_MAP[promptSlug];
    if (!promptText) throw new Error(`Unknown benchmark prompt: ${promptSlug}`);
    return { promptSlug, promptText };
  });
  const existingBuilds = await prisma.build.findMany({
    where: {
      ...arenaCohortBuildWhere([entry.key]),
      prompt: {
        active: true,
        text: { in: publicationPrompts.map((prompt) => prompt.promptText) },
      },
    },
    select: {
      voxelSha256: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      prompt: { select: { text: true } },
    },
  });
  const representationByPromptText = new Map(
    existingBuilds.map((build) => [
      build.prompt.text,
      publicationArtifactRepresentation(build),
    ]),
  );
  const incomingBuilds = publicationPrompts.map(({ promptSlug, promptText }) => {
    const filePath = cohortArtifactPath(entry, promptSlug, uploadsDir);
    return {
      promptSlug,
      promptText,
      voxelSha256: publicationArtifactChecksum(
        fs.readFileSync(filePath),
        representationByPromptText.get(promptText) ?? "inline",
      ),
    };
  });
  const changedPromptSlugs = findChangedPublicationPromptSlugs(
    existingBuilds.map((build) => ({
      promptText: build.prompt.text,
      voxelSha256: build.voxelSha256,
    })),
    incomingBuilds,
  );
  if (changedPromptSlugs.length === 0) return;

  throw new Error(
    `Cannot overwrite ${entry.displayName}: ${changedPromptSlugs.length} benchmark build(s) ` +
      `differ from a cohort with vote history (${changedPromptSlugs.join(", ")}). ` +
      "Publish changed builds under a new model identity or explicitly reset vote and derived rating history first.",
  );
}

export function runPublicationStep(opts: {
  name: string;
  scriptPath: string;
  args: string[];
  dryRun: boolean;
  // Steps without their own --dry-run support are skipped entirely on dry-run
  supportsDryRun: boolean;
}): PublicationStepResult {
  const command = ["tsx", opts.scriptPath, ...opts.args];
  if (opts.dryRun && !opts.supportsDryRun) {
    return { name: opts.name, command, ranFor: "skipped", exitCode: null };
  }

  const finalArgs = opts.dryRun ? [...opts.args, "--dry-run"] : opts.args;
  const tsxCliPath = require.resolve("tsx/cli");
  const result = spawnSync(process.execPath, [tsxCliPath, opts.scriptPath, ...finalArgs], {
    env: process.env,
    stdio: "inherit",
  });
  return {
    name: opts.name,
    command,
    ranFor: opts.dryRun ? "dry-run" : "real",
    exitCode: result.status,
  };
}

// Verification green means: the model has a build for every prompt in the
// cohort, every one of those builds has core metadata, and every
// policy-required artifact object exists. Artifact coverage alone is not
// enough, because an import that never landed leaves no row to inspect and
// would otherwise read as a clean, empty result.
export async function verifyPublicationCoverage(modelKey: string) {
  const coverage = await getArenaArtifactCoverage([modelKey]);
  const expectedPromptSlugs = Object.keys(BENCHMARK_PROMPT_MAP);
  const builtPromptTexts = new Set(
    (
      await prisma.build.findMany({
        where: arenaCohortBuildWhere([modelKey]),
        select: { prompt: { select: { text: true } } },
      })
    ).map((row) => row.prompt.text),
  );
  const missingPromptSlugs = expectedPromptSlugs.filter(
    (slug) => !builtPromptTexts.has(BENCHMARK_PROMPT_MAP[slug]),
  );

  const complete =
    coverage.error == null &&
    coverage.missingBuildIds != null &&
    coverage.missingBuildIds.length === 0 &&
    missingPromptSlugs.length === 0;
  return { coverage, complete, missingPromptSlugs };
}

export async function assertDeployedPublicationCoverage(
  siteUrl: string,
  modelKey: string,
): Promise<void> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) throw new Error("Missing ADMIN_TOKEN for deployed publication verification");
  const url = new URL(`${siteUrl.replace(/\/+$/, "")}/api/admin/status`);
  url.searchParams.set("modelKey", modelKey);

  const resp = await fetch(url, {
    headers: publicationAdminHeaders(token),
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `Deployed publication verification failed (${resp.status}). ` +
        "Confirm the site URL, ADMIN_TOKEN, and deployment protection bypass.",
    );
  }

  const status = (await resp.json()) as {
    artifacts?: { modelKey?: unknown; missingBuildIds?: unknown; error?: unknown };
  };
  const artifacts = status.artifacts;
  if (
    artifacts?.modelKey !== modelKey ||
    artifacts.error !== null ||
    !Array.isArray(artifacts.missingBuildIds) ||
    !artifacts.missingBuildIds.every((id) => typeof id === "string")
  ) {
    throw new Error("Deployment returned an invalid artifact status; model stays staged");
  }
  if (artifacts.missingBuildIds.length > 0) {
    throw new Error(
      `Deployment reports ${artifacts.missingBuildIds.length} build(s) needing work; model stays staged: ` +
        artifacts.missingBuildIds.join(", "),
    );
  }
}

// Republishing overwrites the cohort one build at a time while import-build
// deliberately leaves an existing model's enabled flag alone. Staging the model
// first keeps a half-replaced cohort off public surfaces, which is the same
// guarantee a first publication gets.
export async function stagePublishedModel(modelKey: string): Promise<PublicationStageState> {
  const model = await prisma.model.findUnique({
    where: { key: modelKey },
    select: { enabled: true },
  });
  if (!model) return "missing";
  if (!model.enabled) return "already-staged";
  await prisma.model.update({ where: { key: modelKey }, data: { enabled: false } });
  return "staged";
}

export function publicationNeedsCacheDrain(stageState: PublicationStageState): boolean {
  return stageState !== "missing";
}

export function publicationShouldRestoreAfterGuardFailure(
  stageState: PublicationStageState,
): boolean {
  return stageState === "staged";
}

export async function activatePublishedModel(modelKey: string): Promise<void> {
  await prisma.model.update({ where: { key: modelKey }, data: { enabled: true } });
}

// The upload step imports through an HTTP endpoint while every later step runs
// Prisma against DATABASE_URL. Those can point at different environments, in
// which case publication would overwrite one environment's builds and then
// verify and activate another. The deployment reports the database it is
// actually using, so compare that against ours before writing anything.
export async function assertPublicationTargetsAgree(
  siteUrl: string,
): Promise<{ matchupStateCacheTtlMs: number }> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL for publication");
  const local = databaseIdentityFromUrl(databaseUrl);
  if (!local) throw new Error("Could not parse DATABASE_URL for the publication preflight");

  const token = process.env.ADMIN_TOKEN;
  if (!token) throw new Error("Missing ADMIN_TOKEN for publication preflight");

  const resp = await fetch(`${siteUrl.replace(/\/+$/, "")}/api/admin/status`, {
    headers: publicationAdminHeaders(token),
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `Publication preflight could not read ${siteUrl}/api/admin/status (${resp.status}). ` +
        "Confirm the site URL, ADMIN_TOKEN, and deployment protection bypass.",
    );
  }

  const status = (await resp.json()) as {
    db?: {
      projectRef?: string | null;
      host?: string;
      port?: string;
      database?: string;
      schema?: string;
    };
    arena?: { matchupStateCacheTtlMs?: number };
    storage?: {
      projectRef?: string | null;
      bucket?: string | null;
      ready?: boolean;
      error?: unknown;
    };
  };
  if (!status.db?.host || !status.db.database || !status.db.schema) {
    throw new Error("Publication preflight got no database identity from the deployment");
  }
  const remote = {
    projectRef: status.db.projectRef ?? null,
    host: status.db.host.toLowerCase(),
    port: status.db.port ?? "5432",
    database: status.db.database.toLowerCase(),
    schema: status.db.schema.toLowerCase(),
  };
  const matchupStateCacheTtlMs = status.arena?.matchupStateCacheTtlMs;
  if (
    typeof matchupStateCacheTtlMs !== "number" ||
    !Number.isInteger(matchupStateCacheTtlMs) ||
    matchupStateCacheTtlMs < 0
  ) {
    throw new Error("Publication preflight got no valid matchup cache TTL from the deployment");
  }

  if (!isSameDatabaseTarget(local, remote)) {
    const describe = (id: typeof remote) =>
      `${id.projectRef ? `project ${id.projectRef}` : `${id.host}:${id.port}`}` +
      `/${id.database}?schema=${encodeURIComponent(id.schema)}`;
    throw new Error(
      `Publication target mismatch: uploads go to ${siteUrl} (${describe(remote)}) ` +
        `but verification and activation would run against ${describe(local)}. ` +
        "Point MINEBENCH_SITE_URL and DATABASE_URL at the same environment.",
    );
  }

  const deployedStorage = status.storage;
  const deployedStorageError =
    typeof deployedStorage?.error === "string" && deployedStorage.error.trim()
      ? `: ${deployedStorage.error.trim()}`
      : "";
  if (deployedStorage?.ready !== true) {
    throw new Error(
      `Publication preflight reports deployed storage is not ready${deployedStorageError}`,
    );
  }
  const deployedStorageRef = deployedStorage.projectRef?.trim().toLowerCase() || null;
  if (!deployedStorageRef) {
    throw new Error(
      "Publication preflight could not identify the deployment's Supabase storage project",
    );
  }
  if (!remote.projectRef || deployedStorageRef !== remote.projectRef) {
    throw new Error(
      `Publication deployment mismatch: runtime storage uses project ${deployedStorageRef}, ` +
        `while the deployed database is ${remote.projectRef ? `project ${remote.projectRef}` : "not a Supabase project"}. ` +
        "Point the deployment's database and storage configuration at the same environment.",
    );
  }

  // Uploads write to SUPABASE_URL directly, bypassing the deployment entirely,
  // so a verified database target still permits overwriting another project's
  // storage with deterministic build and artifact paths.
  // This fails closed: an unmatched storage endpoint is refused rather than
  // allowed, because the uploader writes to deterministic paths and a wrong
  // target overwrites another environment's builds before anything else fails.
  const storageUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const storageServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (storageUrl && storageServiceRoleKey) {
    const storageRef = supabaseProjectRefFromApiUrl(storageUrl);
    if (!storageRef) {
      throw new Error(
        `Publication storage target could not be identified from SUPABASE_URL (${storageUrl}). ` +
          "Publication refuses to upload to storage it cannot match against the database target.",
      );
    }
    if (!local.projectRef) {
      throw new Error(
        `Publication storage mismatch: uploads would write to Supabase project ${storageRef}, ` +
          "but the database target is not a Supabase project so the two cannot be matched. " +
          "Point DATABASE_URL and SUPABASE_URL at the same environment.",
      );
    }
    if (storageRef !== local.projectRef) {
      throw new Error(
        `Publication storage mismatch: uploads would write to Supabase project ${storageRef} ` +
          `while the database is project ${local.projectRef}. ` +
          "Point SUPABASE_URL at the same environment as DATABASE_URL.",
      );
    }
  }

  console.log(
    `- publication target: ${siteUrl} (${remote.projectRef ?? `${remote.host}:${remote.port}`})`,
  );
  return { matchupStateCacheTtlMs };
}
