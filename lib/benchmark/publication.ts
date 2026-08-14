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
