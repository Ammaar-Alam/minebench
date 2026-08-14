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
  if (entry.importOnly) {
    throw new Error(`${entry.displayName} is import-only; publish its imported builds instead.`);
  }
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
  const localHost = new URL(databaseUrl).hostname.toLowerCase();

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

  const status = (await resp.json()) as { db?: { host?: string } };
  const remoteHost = status.db?.host?.toLowerCase();
  if (!remoteHost) throw new Error("Publication preflight got no database host from the deployment");
  if (remoteHost !== localHost) {
    throw new Error(
      `Publication target mismatch: uploads go to ${siteUrl} (database ${remoteHost}) ` +
        `but verification and activation would run against ${localHost}. ` +
        "Point MINEBENCH_SITE_URL and DATABASE_URL at the same environment.",
    );
  }
  console.log(`- publication target: ${siteUrl} (database ${remoteHost})`);
}
