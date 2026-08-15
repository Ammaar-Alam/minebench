#!/usr/bin/env -S tsx

import "dotenv/config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../lib/prisma";
import {
  acquireModelPublicationLock,
  activatePublishedModel,
  assertRatedModelCohortUnchanged,
  assertDeployedPublicationCoverage,
  assertPublicationTargetsAgree,
  missingCohortArtifacts,
  publicationNeedsCacheDrain,
  publicationShouldRestoreAfterGuardFailure,
  resolvePublicationModel,
  runPublicationStep,
  stagePublishedModel,
  verifyPublicationCoverage,
  type ModelPublicationLock,
  type PublicationStepResult,
} from "../lib/benchmark/publication";
import { BENCHMARK_PROMPT_MAP, UPLOADS_DIR } from "./uploadsCatalog";

/**
 * Publish a benchmarked model end to end.
 *
 * Usage:
 *   pnpm model:publish --model <slug|key>            # full pipeline
 *   pnpm model:publish --model <slug|key> --dry-run  # report without writing
 *   pnpm model:publish --model <slug|key> --skip-upload
 *
 * Pipeline: upload cohort -> metadata backfill -> snapshot precompute ->
 * stream precompute (each missing-only, scoped to the model) -> policy-aware
 * verification -> benchmark metrics refresh -> activation.
 * A staged (disabled) model goes live only after verification passes.
 */

type Args = {
  model: string;
  dryRun: boolean;
  skipUpload: boolean;
};

let publicationLock: ModelPublicationLock | null = null;

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: pnpm model:publish --model <slug|key> [--dry-run] [--skip-upload]",
    );
    process.exit(0);
  }

  const modelValues: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--model") continue;
    const next = args[i + 1]?.trim();
    if (next) modelValues.push(next);
  }
  if (modelValues.length !== 1) {
    throw new Error("Pass exactly one --model <slug|key>.");
  }

  return {
    model: modelValues[0],
    dryRun: args.includes("--dry-run"),
    skipUpload: args.includes("--skip-upload"),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const entry = resolvePublicationModel(opts.model);
  const promptSlugs = Object.keys(BENCHMARK_PROMPT_MAP);

  console.log(`Publishing ${entry.displayName} (${entry.key})`);
  console.log(`- dry run: ${opts.dryRun ? "yes" : "no"}`);
  console.log(`- cohort: ${promptSlugs.length} prompts`);
  console.log("");

  // Uploads and verification must address the same environment before any
  // write happens; a dry run performs no writes so it can skip the network call
  const siteUrl = (process.env.MINEBENCH_SITE_URL ?? "https://minebench.ai").replace(/\/+$/, "");
  // the uploader reads this too, so the checked target is the one it uses
  process.env.MINEBENCH_SITE_URL = siteUrl;
  let matchupStateCacheTtlMs = 0;
  if (!opts.dryRun) {
    ({ matchupStateCacheTtlMs } = await assertPublicationTargetsAgree(siteUrl));
  }

  if (!opts.skipUpload) {
    // Hard-fail before any step when the local cohort is incomplete
    const missingArtifacts = missingCohortArtifacts(entry, promptSlugs, UPLOADS_DIR);
    if (missingArtifacts.length > 0) {
      console.error(`Missing ${missingArtifacts.length} benchmark artifact(s):`);
      for (const filePath of missingArtifacts) console.error(`- ${filePath}`);
      console.error(
        entry.importOnly
          ? `\n${entry.displayName} is import-only: drop the build JSON into each uploads/<prompt>/ folder, then re-run.`
          : "\nGenerate them first: pnpm batch:generate --generate --model " + entry.slug,
      );
      process.exitCode = 1;
      return;
    }
  }

  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const steps: PublicationStepResult[] = [];
  const runStep = async (
    name: string,
    script: string,
    args: string[],
    supportsDryRun: boolean,
  ) => {
    await publicationLock?.assertHeld();
    console.log(`\n== ${name}`);
    const result = runPublicationStep({
      name,
      scriptPath: path.join(scriptsDir, script),
      args,
      dryRun: opts.dryRun,
      supportsDryRun,
    });
    steps.push(result);
    if (result.ranFor !== "skipped" && result.exitCode !== 0) {
      throw new Error(`Step failed: ${name} (exit ${result.exitCode})`);
    }
    if (result.ranFor === "skipped") {
      console.log(`(skipped on dry-run: ${name} has no side-effect-free mode)`);
    }
    await publicationLock?.assertHeld();
  };

  if (!opts.dryRun) {
    publicationLock = await acquireModelPublicationLock(entry.key);
    console.log("- publication lock: acquired");
  }

  // Upload is an idempotent reconcile: storage upserts plus import-build
  // overwrite, and it already pre-writes stream artifacts for large builds
  if (!opts.skipUpload) {
    await assertRatedModelCohortUnchanged(entry, promptSlugs, UPLOADS_DIR);
    // Take an already-live model off public surfaces before its builds are
    // replaced. Without this the cohort is swapped underneath active traffic
    // and a failure part-way leaves votes landing on a mixed old/new cohort.
    if (!opts.dryRun) {
      const stageState = await stagePublishedModel(entry.key);
      if (publicationNeedsCacheDrain(stageState)) {
        console.log(
          `- ${stageState === "staged" ? "staged" : "resuming staged"} ${entry.displayName} before overwriting its cohort; ` +
            "it is reactivated after verification, and stays staged if publication fails",
        );
        if (matchupStateCacheTtlMs > 0) {
          console.log(
            `- waiting ${matchupStateCacheTtlMs}ms for deployed matchup caches to expire`,
          );
          await delay(matchupStateCacheTtlMs);
        }
      }
      await publicationLock?.assertHeld();
      // Repeat after draining votes that may have committed during staging
      try {
        await assertRatedModelCohortUnchanged(entry, promptSlugs, UPLOADS_DIR);
      } catch (error) {
        if (publicationShouldRestoreAfterGuardFailure(stageState)) {
          await activatePublishedModel(entry.key);
        }
        throw error;
      }
    }

    // Scoped to the cohort prompts: batch-generate derives its prompt list
    // from every uploads/ directory as well as the benchmark map, so a model
    // filter alone would upload custom-prompt artifacts with overwrite=1 and
    // could overwrite unrelated builds or fail publication on one of them.
    await runStep(
      "upload cohort",
      "batch-generate.ts",
      ["--upload", "--model", entry.slug, "--prompt", ...promptSlugs],
      false,
    );
  }

  const scope = ["--model", entry.slug, "--missing-only", "--all"];
  await runStep("metadata backfill", "backfill-arena-build-metadata.ts", scope, true);
  await runStep("snapshot precompute", "precompute-arena-snapshot-artifacts.ts", scope, true);
  await runStep("stream precompute", "precompute-arena-stream-artifacts.ts", scope, true);

  console.log("\n== verification");
  const { coverage, complete, missingPromptSlugs } = await verifyPublicationCoverage(entry.key);
  console.log(`- cohort prompts without a build: ${missingPromptSlugs.length}`);
  console.log(`- cohort builds needing work: ${coverage.missingBuildIds?.length ?? "unknown"}`);
  console.log(`- missing core metadata: ${coverage.buildsMissingCoreMetadata ?? "unknown"}`);
  console.log(`- missing snapshot artifacts: ${coverage.snapshotMissing ?? "unknown"}`);
  console.log(`- stream builds incomplete: ${coverage.buildsMissingVariants ?? "unknown"}`);
  if (coverage.error) console.log(`- probe error: ${coverage.error}`);

  if (!complete) {
    if (opts.dryRun) {
      console.log(
        "\nDry run: verification is not green yet; a real run would stop here without activating.",
      );
      return;
    }
    console.error("\nVerification incomplete; model stays staged. Re-run to reconcile.");
    if (missingPromptSlugs.length > 0) {
      console.error(`Prompts with no imported build: ${missingPromptSlugs.join(", ")}`);
    }
    if (coverage.missingBuildIds && coverage.missingBuildIds.length > 0) {
      console.error(`Builds needing work: ${coverage.missingBuildIds.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!opts.dryRun) {
    await assertDeployedPublicationCoverage(siteUrl, entry.key);
    console.log("- deployed artifact policy: complete");
  }

  // Metrics refresh only after verification; a status run folds the ledger
  // into the committed generated metrics when the cohort is complete
  await runStep("metrics refresh", "batch-generate.ts", ["--model", entry.slug], false);

  if (opts.dryRun) {
    console.log("\nDry run complete: no uploads, writes, metrics, or activation performed.");
    return;
  }

  const model = await prisma.model.findUnique({
    where: { key: entry.key },
    select: { enabled: true },
  });
  if (!model) {
    console.error("Model row missing after upload; aborting before activation.");
    process.exitCode = 1;
    return;
  }
  await publicationLock?.assertHeld();
  if (model.enabled) {
    console.log("\nModel already active; publication reconciled.");
  } else {
    await activatePublishedModel(entry.key);
    console.log(`\nActivated ${entry.displayName}.`);
  }
  console.log("Remember to commit lib/ai/modelBenchmarkMetrics.generated.json if it changed.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await publicationLock?.release();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
    await prisma.$disconnect().catch(() => undefined);
  });
