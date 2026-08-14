import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  findCatalogEntryBySlugOrKey,
  type ModelCatalogEntry,
} from "@/lib/ai/modelCatalog";
import { getArenaArtifactCoverage } from "@/lib/arena/artifactCoverage";
import { arenaCohortBuildWhere } from "@/lib/arena/eligibility";
import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";
import {
  databaseIdentityFromUrl,
  isSameDatabaseTarget,
  supabaseProjectRefFromApiUrl,
} from "@/lib/db/identity";
import { prisma } from "@/lib/prisma";

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

export type PublicationReport = {
  modelKey: string;
  steps: PublicationStepResult[];
  verification: Awaited<ReturnType<typeof getArenaArtifactCoverage>> | null;
  activated: boolean;
};

// Exactly one canonical key or slug; substring matching is not accepted here
export function resolvePublicationModel(value: string): ModelCatalogEntry {
  const entry = findCatalogEntryBySlugOrKey(value);
  if (!entry) {
    throw new Error(`Unknown model key or slug: '${value}'. Pass the exact catalog key or slug.`);
  }
  // import-only models cannot be generated through provider APIs, but their
  // supplied cohort still has to be uploaded, verified, and activated, and
  // publication is the only path that activates anything
  return entry;
}

// The benchmark cohort files that must exist locally before publication
export function missingCohortArtifacts(
  entry: ModelCatalogEntry,
  promptSlugs: readonly string[],
  uploadsDir: string,
): string[] {
  return promptSlugs
    .map((promptSlug) =>
      path.join(uploadsDir, promptSlug, `${promptSlug}-${entry.slug}.json`),
    )
    .filter((filePath) => {
      try {
        return !fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0;
      } catch {
        return true;
      }
    });
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

export async function activatePublishedModel(modelKey: string): Promise<void> {
  await prisma.model.update({ where: { key: modelKey }, data: { enabled: true } });
}

// The upload step imports through an HTTP endpoint while every later step runs
// Prisma against DATABASE_URL. Those can point at different environments, in
// which case publication would overwrite one environment's builds and then
// verify and activate another. The deployment reports the database it is
// actually using, so compare that against ours before writing anything.
export async function assertPublicationTargetsAgree(siteUrl: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL for publication");
  const local = databaseIdentityFromUrl(databaseUrl);
  if (!local) throw new Error("Could not parse DATABASE_URL for the publication preflight");

  const token = process.env.ADMIN_TOKEN;
  if (!token) throw new Error("Missing ADMIN_TOKEN for publication preflight");
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

  const resp = await fetch(`${siteUrl.replace(/\/+$/, "")}/api/admin/status`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
    },
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `Publication preflight could not read ${siteUrl}/api/admin/status (${resp.status}). ` +
        "Confirm the site URL, ADMIN_TOKEN, and deployment protection bypass.",
    );
  }

  const status = (await resp.json()) as {
    db?: { projectRef?: string | null; host?: string; port?: string; database?: string };
  };
  if (!status.db?.host) {
    throw new Error("Publication preflight got no database identity from the deployment");
  }
  const remote = {
    projectRef: status.db.projectRef ?? null,
    host: status.db.host.toLowerCase(),
    port: status.db.port ?? "5432",
    database: (status.db.database ?? "postgres").toLowerCase(),
  };

  if (!isSameDatabaseTarget(local, remote)) {
    const describe = (id: typeof remote) =>
      id.projectRef ? `project ${id.projectRef}` : `${id.host}:${id.port}/${id.database}`;
    throw new Error(
      `Publication target mismatch: uploads go to ${siteUrl} (${describe(remote)}) ` +
        `but verification and activation would run against ${describe(local)}. ` +
        "Point MINEBENCH_SITE_URL and DATABASE_URL at the same environment.",
    );
  }
  // Uploads write to SUPABASE_URL directly, bypassing the deployment entirely,
  // so a verified database target still permits overwriting another project's
  // storage with deterministic build and artifact paths.
  // This fails closed: an unmatched storage endpoint is refused rather than
  // allowed, because the uploader writes to deterministic paths and a wrong
  // target overwrites another environment's builds before anything else fails.
  const storageUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (storageUrl) {
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
}
