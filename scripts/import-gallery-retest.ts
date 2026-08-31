#!/usr/bin/env -S tsx

import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCatalogEntryBySlugOrKey } from "../lib/ai/modelCatalog";
import {
  runCustomBuildGenerateJob,
  validateGeneratedBuildForArtifacts,
  type ImportedCustomBuildResult,
} from "../lib/custom-builds/generateJob";
import { completeCustomBuildJob, failCustomBuildJob } from "../lib/custom-builds/jobs";
import { assertCustomBuildStorageConfigured, getCustomBuildStorageBucket } from "../lib/custom-builds/storage";
import { assertSavedGenerationStorageAvailable } from "../lib/generations/service";
import {
  addGalleryExample,
  setGalleryCandidateSelected,
  submitGalleryCandidate,
} from "../lib/gallery/service";
import { prisma } from "../lib/prisma";
import { sha256Hex } from "../lib/custom-builds/hash";
import { BenchmarkMetricsStore, type BenchmarkMetricJob } from "./benchmarkMetrics";
import { galleryDatabaseTarget, loadMineBenchGalleryPublisher } from "./gallery-cli";
import { BENCHMARK_PROMPT_MAP, UPLOADS_DIR } from "./uploadsCatalog";

const GRID_SIZE = 256;
const PALETTE = "simple";
const IMPORT_LEASE_MS = 60 * 60 * 1000;

export type GalleryImportArgs = {
  help: false;
  promptSlug: string;
  model: string;
  confirmed: boolean;
};

function optionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

export function parseGalleryImportArgs(argv: string[]): GalleryImportArgs | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.length !== 1) throw new Error("Use --help by itself.");
    return { help: true };
  }

  let promptSlug: string | null = null;
  let model: string | null = null;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt") {
      if (promptSlug) throw new Error("Pass --prompt once.");
      promptSlug = optionValue(argv, index, "--prompt");
      index += 1;
    } else if (arg === "--model") {
      if (model) throw new Error("Pass --model once.");
      model = optionValue(argv, index, "--model");
      index += 1;
    } else if (arg === "--yes") {
      if (confirmed) throw new Error("Pass --yes once.");
      confirmed = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!promptSlug || !model) {
    throw new Error("Pass one official --prompt and one catalog --model.");
  }
  return { help: false, promptSlug, model, confirmed };
}

export function resolveGalleryImportSpec(
  args: GalleryImportArgs,
  uploadsDir = UPLOADS_DIR,
) {
  if (!Object.hasOwn(BENCHMARK_PROMPT_MAP, args.promptSlug)) {
    throw new Error(`Unknown official prompt: ${args.promptSlug}`);
  }
  const model = findCatalogEntryBySlugOrKey(args.model);
  if (!model) throw new Error(`Unknown catalog model: ${args.model}`);
  return {
    promptSlug: args.promptSlug,
    promptText: BENCHMARK_PROMPT_MAP[args.promptSlug]!,
    model,
    filePath: path.join(
      uploadsDir,
      args.promptSlug,
      `${args.promptSlug}-${model.slug}.json`,
    ),
  };
}

export function galleryRetestPublicId(parts: {
  publisherId: string;
  promptSlug: string;
  modelKey: string;
  sourceArtifactSha256: string;
  completedAt: string;
}): string {
  const digest = createHash("sha256")
    .update([
      "gallery-retest-v1",
      parts.publisherId,
      parts.promptSlug,
      parts.modelKey,
      parts.sourceArtifactSha256,
      parts.completedAt,
    ].join("\0"))
    .digest("base64url");
  return `cb_${digest.slice(0, 24)}`;
}

function readPreparedBuild(spec: ReturnType<typeof resolveGalleryImportSpec>): {
  importedBuild: ImportedCustomBuildResult;
  sourceBytes: number;
  providerRoute: "direct" | "openrouter";
  reasoning: string | null;
} {
  const file = statSync(spec.filePath);
  if (!file.isFile()) throw new Error(`Build artifact is not a file: ${spec.filePath}`);
  const bytes = readFileSync(spec.filePath);
  const sourceArtifactSha256 = sha256Hex(bytes);
  const metricJob: BenchmarkMetricJob = {
    promptSlug: spec.promptSlug,
    promptText: spec.promptText,
    modelKey: spec.model.key,
    modelSlug: spec.model.slug,
    filePath: spec.filePath,
  };
  const completed = new BenchmarkMetricsStore().getSucceededSample(metricJob);
  if (!completed) {
    throw new Error(`No succeeded benchmark record for ${spec.promptSlug} × ${spec.model.displayName}.`);
  }
  if (
    completed.sample.artifactSha256 !== sourceArtifactSha256 ||
    completed.sample.jsonBytes !== bytes.byteLength
  ) {
    throw new Error("Build artifact does not match its finalized benchmark record.");
  }
  const configuration = completed.sample.configuration;
  if (
    configuration?.promptSha256 !== sha256Hex(spec.promptText) ||
    !configuration.toolsEnabled
  ) {
    throw new Error("Benchmark record does not match the official prompt and tool configuration.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Build artifact is not valid JSON: ${spec.filePath}`);
  }
  const validated = validateGeneratedBuildForArtifacts(parsed, {
    gridSize: GRID_SIZE,
    palette: PALETTE,
  });
  return {
    importedBuild: {
      build: validated.build,
      warnings: validated.warnings,
      blockCount: validated.build.blocks.length,
      generationTimeMs: completed.sample.inferenceTimeMs,
      completedAt: completed.completedAt,
      sourceArtifactSha256,
    },
    sourceBytes: bytes.byteLength,
    providerRoute: configuration.providerRoute,
    reasoning: configuration.reasoningOverride,
  };
}

async function createOrReuseGeneration(args: {
  publisherId: string;
  spec: ReturnType<typeof resolveGalleryImportSpec>;
  prepared: ReturnType<typeof readPreparedBuild>;
}) {
  const publicId = galleryRetestPublicId({
    publisherId: args.publisherId,
    promptSlug: args.spec.promptSlug,
    modelKey: args.spec.model.key,
    sourceArtifactSha256: args.prepared.importedBuild.sourceArtifactSha256,
    completedAt: args.prepared.importedBuild.completedAt.toISOString(),
  });
  const proposedId = randomUUID();
  const jobId = randomUUID();
  const workerId = `gallery-import-${process.pid}-${randomUUID()}`;
  const now = new Date();
  const startedAt = new Date(
    args.prepared.importedBuild.completedAt.getTime() -
      (args.prepared.importedBuild.generationTimeMs ?? 0),
  );

  const generation = await prisma.$transaction(async (tx) => {
    const row = await tx.customBuild.upsert({
      where: { publicId },
      create: {
        id: proposedId,
        publicId,
        ownerId: args.publisherId,
        status: "queued",
        currentStage: "queued",
        startedAt,
        promptText: args.spec.promptText,
        promptSha256: sha256Hex(args.spec.promptText),
        gridSize: GRID_SIZE,
        palette: PALETTE,
        mode: "precise",
        generationMode: "tool",
        modelKind: "catalog",
        modelKey: args.spec.model.key,
        modelProvider: args.spec.model.provider,
        modelId: args.spec.model.modelId,
        modelDisplayName: args.spec.model.displayName,
        openRouterModelId: args.spec.model.openRouterModelId,
        preferOpenRouter: args.prepared.providerRoute === "openrouter",
        reasoning: args.prepared.reasoning,
        metrics: {
          sourceArtifactSha256: args.prepared.importedBuild.sourceArtifactSha256,
        },
        jobs: {
          create: {
            id: jobId,
            type: "generate",
            status: "running",
            attempts: 1,
            maxAttempts: 1,
            lockedBy: workerId,
            lockedAt: now,
            leaseExpiresAt: new Date(now.getTime() + IMPORT_LEASE_MS),
            startedAt: now,
          },
        },
        events: {
          create: {
            seq: 1,
            type: "queued",
            data: { stage: "queued", source: "official_retest" },
          },
        },
      },
      update: {},
      select: {
        id: true,
        publicId: true,
        ownerId: true,
        promptText: true,
        modelKey: true,
        status: true,
        objectsDeletedAt: true,
        artifacts: {
          where: { kind: "build_json" },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (row.id === proposedId) {
      await tx.user.update({
        where: { id: args.publisherId },
        data: { totalGenerationCount: { increment: 1 } },
      });
      const day = new Date(now.toISOString().slice(0, 10));
      await tx.customBuildStatsDaily.upsert({
        where: { day },
        create: { day, created: 1 },
        update: { created: { increment: 1 } },
      });
    }
    return row;
  });

  if (
    generation.ownerId !== args.publisherId ||
    generation.promptText !== args.spec.promptText ||
    generation.modelKey !== args.spec.model.key
  ) {
    throw new Error("Existing Gallery retest identity does not match this import.");
  }
  if (generation.id !== proposedId) {
    if (
      generation.status !== "succeeded" ||
      generation.objectsDeletedAt ||
      generation.artifacts.length === 0
    ) {
      throw new Error(`Existing Gallery retest is ${generation.status}; review it before retrying.`);
    }
    return { publicId: generation.publicId, created: false };
  }

  const job = await prisma.customBuildJob.findUniqueOrThrow({ where: { id: jobId } });
  try {
    await runCustomBuildGenerateJob(job, { importedBuild: args.prepared.importedBuild });
    await completeCustomBuildJob(job.id, workerId);
  } catch (error) {
    await failCustomBuildJob(
      job.id,
      workerId,
      {
        code: "gallery_import_failed",
        message: error instanceof Error ? error.message : "Gallery import failed.",
      },
      prisma,
      { forceTerminal: true },
    );
    throw error;
  }
  return { publicId: generation.publicId, created: true };
}

function printHelp(): void {
  console.log(`
Import a finalized benchmark rerun as an official Gallery example.

Usage:
  pnpm gallery:import --prompt steampunk --model gemini-3-1-pro
  pnpm gallery:import --prompt steampunk --model gemini-3-1-pro --yes

Without --yes, the command validates and prints the import plan without writing.
`);
}

async function main(): Promise<void> {
  const parsed = parseGalleryImportArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  const spec = resolveGalleryImportSpec(parsed);
  const prepared = readPreparedBuild(spec);
  const publisher = await loadMineBenchGalleryPublisher();
  assertCustomBuildStorageConfigured();
  const publicId = galleryRetestPublicId({
    publisherId: publisher.id,
    promptSlug: spec.promptSlug,
    modelKey: spec.model.key,
    sourceArtifactSha256: prepared.importedBuild.sourceArtifactSha256,
    completedAt: prepared.importedBuild.completedAt.toISOString(),
  });

  console.log(`Gallery retest: ${spec.promptSlug} × ${spec.model.displayName}`);
  console.log(`- publisher: ${publisher.publicNickname}`);
  console.log(`- completed: ${prepared.importedBuild.completedAt.toISOString()}`);
  console.log(`- blocks: ${prepared.importedBuild.blockCount.toLocaleString()}`);
  console.log(`- source: ${spec.filePath}`);
  console.log(`- source bytes: ${prepared.sourceBytes.toLocaleString()}`);
  console.log(`- source sha256: ${prepared.importedBuild.sourceArtifactSha256}`);
  console.log(`- saved generation: ${publicId}`);
  console.log(`- database: ${galleryDatabaseTarget()}`);
  console.log(`- storage bucket: ${getCustomBuildStorageBucket()}`);

  if (!parsed.confirmed) {
    console.log("\nValidated only. Add --yes to import and publish.");
    return;
  }

  const existing = await prisma.customBuild.findUnique({
    where: { publicId },
    select: { status: true },
  });
  if (!existing) await assertSavedGenerationStorageAvailable(publisher.id);
  const generation = await createOrReuseGeneration({
    publisherId: publisher.id,
    spec,
    prepared,
  });
  const submission = await submitGalleryCandidate(publisher.id, {
    generationId: generation.publicId,
    postAnonymously: false,
  });
  if (submission.candidate.prompt !== spec.promptText) {
    throw new Error("Existing Gallery candidate does not exactly match the official prompt.");
  }
  await addGalleryExample(publisher.id, submission.candidate.id, {
    generationId: generation.publicId,
    postAnonymously: false,
  });
  await setGalleryCandidateSelected(publisher.id, submission.candidate.id, true);

  const siteUrl = (process.env.MINEBENCH_SITE_URL?.trim() || "https://minebench.ai").replace(/\/+$/, "");
  console.log(`\n${generation.created ? "Imported" : "Reused"}: ${generation.publicId}`);
  console.log(`Gallery: ${siteUrl}/gallery/${submission.candidate.id}`);
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main()
    .finally(() => prisma.$disconnect())
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
