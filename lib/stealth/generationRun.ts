import { Prisma, type StealthGenerationResultStatus } from "@prisma/client";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { BENCHMARK_PROMPT_COHORT_ID } from "@/lib/benchmark/prompts";
import { getPalette } from "@/lib/blocks/palettes";
import { prisma } from "@/lib/prisma";
import { throwIfGenerationWorkerLeaseLost } from "@/lib/generation-worker/lease";
import { generationProviderSignal } from "@/lib/generation-worker/providerSignal";
import {
  decodeStoredBuildText,
  deleteSupabaseStorageObjects,
  fetchStoredBuildBytes,
} from "@/lib/storage/buildPayload";
import {
  decryptStealthEndpointConfig,
  stealthEndpointSecretValues,
  stealthEndpointConfigToGenerateVoxelBuildArgs,
} from "@/lib/stealth/credentials";
import {
  deleteUnacceptedStealthBuild,
  ensureStealthBuildArtifacts,
  isMissingStealthBuildPayload,
  persistStealthBuild,
} from "@/lib/stealth/generation";
import {
  prepareStealthCohortPrompts,
  STEALTH_COHORT_BUILD,
} from "@/lib/stealth/cohort";
import {
  assertEvaluationOperator,
  isStealthCheckpointSetOpen,
  lockExperiment,
  lockVariant,
  reclaimStaleStealthGenerationRuns,
  sanitizeOperationalError,
  syncExperimentReadiness,
  withStealthGenerationHeartbeat,
  type StealthActor,
} from "@/lib/stealth/service";
import { validateOwnedVoxelBuild } from "@/lib/voxel/validate";

const MAX_GENERATION_ATTEMPTS = 10;
const MAX_GENERATION_CONCURRENCY = 15;
const MAX_STEALTH_BUILD_UPLOAD_BYTES = 320 * 1024 * 1024;
const MAX_STEALTH_BUILD_BLOCKS = 4_000_000;
const { gridSize: GRID_SIZE, palette: PALETTE, mode: MODE } = STEALTH_COHORT_BUILD;

function positiveInt(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be from 1 to ${max}`);
  }
  return value;
}

async function lockGenerationRun(
  db: Prisma.TransactionClient,
  runId: string,
): Promise<{ id: string } | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "StealthGenerationRun"
    WHERE id = ${runId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockGenerationContext(
  db: Prisma.TransactionClient,
  runId: string,
) {
  const identity = await db.stealthGenerationRun.findUnique({
    where: { id: runId },
    select: { variant: { select: { experimentId: true } } },
  });
  if (!identity) return null;
  const experiment = await lockExperiment(db, identity.variant.experimentId);
  if (!experiment || !(await lockGenerationRun(db, runId))) return null;
  return experiment;
}

function summarizeGenerationResults(
  results: ReadonlyArray<{
    status: StealthGenerationResultStatus;
    attempts: number;
    error: string | null;
  }>,
) {
  let lastError: string | null = null;
  for (const result of results) {
    if (result.error) lastError = result.error;
  }
  return {
    completedBuildCount: results.filter((result) => result.status === "READY").length,
    failedBuildCount: results.filter((result) => result.status === "FAILED").length,
    providerCallCount: results.reduce((sum, result) => sum + result.attempts, 0),
    retryCount: results.reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0),
    unfinishedPromptCount: results.filter(
      (result) =>
        result.status === "QUEUED" ||
        result.status === "GENERATING" ||
        result.status === "VALIDATING",
    ).length,
    lastError,
  };
}

function generationConcurrency(configuration: unknown): number {
  const configured =
    typeof configuration === "object" &&
    configuration !== null &&
    "concurrency" in configuration
      ? configuration.concurrency
      : undefined;
  return typeof configured === "number" && Number.isInteger(configured)
    ? Math.max(1, Math.min(MAX_GENERATION_CONCURRENCY, configured))
    : 1;
}

type StealthBuildUploadRef = { bucket: string; path: string };

class InvalidStealthBuildUploadError extends Error {}

async function loadStealthBuildUpload(
  ref: StealthBuildUploadRef,
  signal?: AbortSignal,
) {
  let bytes: Uint8Array;
  try {
    bytes = await fetchStoredBuildBytes(ref, {
      signal,
      maxBytes: MAX_STEALTH_BUILD_UPLOAD_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) {
      throw new InvalidStealthBuildUploadError("Build exceeds the 320 MB upload limit");
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeStoredBuildText(bytes, null, {
        maxOutputBytes: MAX_STEALTH_BUILD_UPLOAD_BYTES,
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) {
      throw new InvalidStealthBuildUploadError("Build exceeds the 320 MB upload limit");
    }
    throw new InvalidStealthBuildUploadError("Build must be valid JSON");
  }
  bytes = new Uint8Array();
  const validated = validateOwnedVoxelBuild(parsed, {
    gridSize: GRID_SIZE,
    palette: getPalette(PALETTE),
    maxBlocks: MAX_STEALTH_BUILD_BLOCKS,
  });
  if (!validated.ok) throw new InvalidStealthBuildUploadError(validated.error);
  return validated.value.build;
}

async function cleanupStealthBuildUpload(
  resultId: string,
  ref: StealthBuildUploadRef,
): Promise<void> {
  try {
    await deleteSupabaseStorageObjects([ref]);
    await prisma.stealthGenerationResult.updateMany({
      where: { id: resultId, uploadBucket: ref.bucket, uploadPath: ref.path },
      data: {
        uploadBucket: null,
        uploadPath: null,
        uploadExpiresAt: null,
        uploadQueuedAt: null,
      },
    });
  } catch {
    // Expiry cleanup owns uploads that cannot be deleted here
  }
}

async function createStealthGenerationRun(
  actor: StealthActor,
  organizationId: string,
  variantId: string,
  params: { maxAttempts: number; concurrency: number },
): Promise<{ runId: string }> {
  const maxAttempts = positiveInt(params.maxAttempts, "Attempts", MAX_GENERATION_ATTEMPTS);
  const concurrency = positiveInt(params.concurrency, "Concurrency", MAX_GENERATION_CONCURRENCY);
  const prompts = await prepareStealthCohortPrompts();
  const identity = await prisma.stealthVariant.findUnique({
    where: { id: variantId },
    select: { experimentId: true },
  });
  if (!identity) throw new Error("Checkpoint not found");

  return prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, identity.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Checkpoint not found");
    }
    const variant = await lockVariant(tx, variantId);
    if (!variant || variant.experimentId !== experiment.id) {
      throw new Error("Checkpoint not found");
    }
    if (experiment.status === "CLOSED") throw new Error("Closed evaluations are read-only");
    if (!isStealthCheckpointSetOpen(experiment.status)) {
      throw new Error("Only draft evaluations can generate builds");
    }
    await reclaimStaleStealthGenerationRuns(tx, variant.id);
    const withCredential = await tx.stealthVariant.findUnique({
      where: { id: variant.id },
      include: { credential: true },
    });
    if (!withCredential || withCredential.source !== "ENDPOINT") {
      throw new Error("Configure an endpoint before generation");
    }
    if (!withCredential.endpointEnabled || !withCredential.credential) {
      throw new Error("Configure an endpoint before generation");
    }
    const activeRun = await tx.stealthGenerationRun.findFirst({
      where: { variantId: variant.id, status: "RUNNING" },
      select: { id: true },
    });
    if (activeRun) throw new Error("Generation is already running");
    const config = decryptStealthEndpointConfig(withCredential.credential.encryptedConfig);
    const run = await tx.stealthGenerationRun.create({
      data: {
        variantId: variant.id,
        status: "RUNNING",
        promptCohortId: BENCHMARK_PROMPT_COHORT_ID,
        expectedBuildCount: prompts.length,
        completedBuildCount: 0,
        failedBuildCount: 0,
        providerCallCount: 0,
        retryCount: 0,
        configuration: {
          protocol: config.protocol,
          credentialFingerprint: withCredential.credential.fingerprint,
          gridSize: GRID_SIZE,
          palette: PALETTE,
          mode: MODE,
          enableTools: config.enableTools,
          requireStructuredOutput: config.requireStructuredOutput,
          reasoning: config.reasoning ?? null,
          maxAttempts,
          concurrency,
        } satisfies Prisma.InputJsonObject,
        results: {
          createMany: {
            data: prompts.map((prompt) => ({
              promptId: prompt.prompt.id,
              status: "QUEUED",
              attempts: 0,
              generationTimeMs: 0,
            })),
          },
        },
      },
      select: { id: true },
    });
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: {
        status: "GENERATING",
        expectedBuildCount: prompts.length,
        generatedBuildCount: 0,
        generationFailureCount: 0,
        lastGenerationError: null,
      },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "GENERATING" },
    });
    return { runId: run.id };
  });
}

export async function startStealthGeneration(
  actor: StealthActor,
  organizationId: string,
  variantId: string,
  params: { maxAttempts: number; concurrency: number },
): Promise<{ runId: string }> {
  return createStealthGenerationRun(actor, organizationId, variantId, params);
}

export async function terminalizeStealthGenerationRunsForClosure(
  tx: Prisma.TransactionClient,
  experimentId: string,
): Promise<void> {
  const runs = await tx.stealthGenerationRun.findMany({
    where: { status: "RUNNING", variant: { experimentId } },
    select: { id: true, expectedBuildCount: true },
  });
  for (const run of runs) {
    const currentResults = await tx.stealthGenerationResult.findMany({
      where: { runId: run.id },
      orderBy: { updatedAt: "asc" },
      select: { status: true, attempts: true, error: true },
    });
    const currentProgress = summarizeGenerationResults(currentResults);
    const complete =
      currentProgress.completedBuildCount === run.expectedBuildCount &&
      currentProgress.failedBuildCount === 0;
    if (!complete) {
      await tx.stealthGenerationResult.updateMany({
        where: { runId: run.id, status: { in: ["QUEUED", "GENERATING", "VALIDATING"] } },
        data: {
          status: "FAILED",
          error: "Evaluation closed",
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
        },
      });
    }
    const results = complete
      ? currentResults
      : await tx.stealthGenerationResult.findMany({
          where: { runId: run.id },
          orderBy: { updatedAt: "asc" },
          select: { status: true, attempts: true, error: true },
        });
    const progress = summarizeGenerationResults(results);
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        status: complete ? "SUCCEEDED" : progress.completedBuildCount > 0 ? "PARTIAL" : "FAILED",
        completedBuildCount: progress.completedBuildCount,
        failedBuildCount: complete
          ? 0
          : Math.max(
              progress.failedBuildCount,
              run.expectedBuildCount - progress.completedBuildCount,
            ),
        providerCallCount: progress.providerCallCount,
        retryCount: progress.retryCount,
        error: complete ? null : "Evaluation closed",
        completedAt: new Date(),
      },
    });
  }
}

export async function failStealthGenerationRun(runId: string, error: unknown): Promise<void> {
  const message = sanitizeOperationalError(error);
  await prisma.$transaction(async (tx) => {
    const experiment = await lockGenerationContext(tx, runId);
    if (!experiment) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      include: { variant: true },
    });
    if (!run || run.status !== "RUNNING") return;
    const currentResults = await tx.stealthGenerationResult.findMany({
      where: { runId: run.id },
      orderBy: { updatedAt: "asc" },
      select: { status: true, attempts: true, error: true },
    });
    const currentProgress = summarizeGenerationResults(currentResults);
    const complete =
      currentProgress.completedBuildCount === run.expectedBuildCount &&
      currentProgress.failedBuildCount === 0;
    if (complete) {
      await tx.stealthGenerationRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          completedBuildCount: currentProgress.completedBuildCount,
          failedBuildCount: 0,
          providerCallCount: currentProgress.providerCallCount,
          retryCount: currentProgress.retryCount,
          error: null,
          completedAt: new Date(),
        },
      });
      if (experiment.status !== "CLOSED") {
        await tx.stealthVariant.updateMany({
          where: { id: run.variantId, status: { not: "WITHDRAWN" } },
          data: {
            status: "READY",
            endpointEnabled: false,
            generatedBuildCount: currentProgress.completedBuildCount,
            generationFailureCount: 0,
            cohortGeneratedAt: new Date(),
            lastGenerationError: null,
          },
        });
        await syncExperimentReadiness(tx, run.variant.experimentId);
      }
      await tx.stealthEndpointCredential.deleteMany({ where: { variantId: run.variantId } });
      return;
    }
    await tx.stealthGenerationResult.updateMany({
      where: { runId: run.id, status: { in: ["QUEUED", "GENERATING", "VALIDATING"] } },
      data: {
        status: "FAILED",
        error: message,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    const results = await tx.stealthGenerationResult.findMany({
      where: { runId: run.id },
      orderBy: { updatedAt: "asc" },
      select: { status: true, attempts: true, error: true },
    });
    const progress = summarizeGenerationResults(results);
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        status: progress.completedBuildCount > 0 ? "PARTIAL" : "FAILED",
        completedBuildCount: progress.completedBuildCount,
        failedBuildCount: progress.failedBuildCount,
        providerCallCount: progress.providerCallCount,
        retryCount: progress.retryCount,
        error: message,
        completedAt: new Date(),
      },
    });
    if (experiment.status !== "CLOSED") {
      await tx.stealthVariant.updateMany({
        where: { id: run.variantId, status: { not: "WITHDRAWN" } },
        data: {
          status: progress.completedBuildCount > 0 ? "GENERATING" : "DRAFT",
          generatedBuildCount: progress.completedBuildCount,
          generationFailureCount: progress.failedBuildCount,
          lastGenerationError: message,
        },
      });
      await syncExperimentReadiness(tx, run.variant.experimentId);
    }
  });
}

async function acceptStealthGenerationBuild(params: {
  runId: string;
  resultIdentity: { runId: string; promptId: string };
  fromStatus: "GENERATING" | "VALIDATING";
  buildId: string;
  attempts: number;
  generationTimeMs: number;
  requestConfiguration: string | null;
  workerId?: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const experiment = await lockGenerationContext(tx, params.runId);
    if (!experiment) return false;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: params.runId },
      select: {
        status: true,
        variant: { select: { endpointEnabled: true, source: true } },
      },
    });
    if (
      !run ||
      run.status !== "RUNNING" ||
      (run.variant.source !== "UPLOAD" && !run.variant.endpointEnabled)
    ) {
      return false;
    }
    if (!experiment || !isStealthCheckpointSetOpen(experiment.status)) return false;
    const accepted = await tx.stealthGenerationResult.updateMany({
      where: {
        ...params.resultIdentity,
        status: params.fromStatus,
        ...(params.workerId ? { lockedBy: params.workerId } : {}),
      },
      data: {
        buildId: params.buildId,
        status: "READY",
        attempts: params.attempts,
        generationTimeMs: params.generationTimeMs,
        requestConfiguration: params.requestConfiguration,
        error: null,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    return accepted.count === 1;
  });
}

export async function generateStealthPromptForRun(params: {
  runId: string;
  promptSlug?: string;
  promptId?: string;
  workerId?: string;
  signal?: AbortSignal;
  acquireBuildProcessing?: () => Promise<() => void>;
}): Promise<void> {
  const identity = await prisma.stealthGenerationRun.findUnique({
    where: { id: params.runId },
    select: { promptCohortId: true },
  });
  if (!identity) throw new Error("Generation run not found");
  if (identity.promptCohortId !== BENCHMARK_PROMPT_COHORT_ID) {
    throw new Error("The generation prompt cohort has changed");
  }
  const prompts = await prepareStealthCohortPrompts();
  const entry = prompts.find((prompt) =>
    params.promptId ? prompt.prompt.id === params.promptId : prompt.slug === params.promptSlug,
  );
  if (!entry) throw new Error("Prompt not found");
  const resultIdentity = { runId: params.runId, promptId: entry.prompt.id };
  const resultKey = { runId_promptId: resultIdentity };

  const run = await prisma.$transaction(async (tx) => {
    const experiment = await lockGenerationContext(tx, params.runId);
    if (!experiment) throw new Error("Generation run not found");
    const currentRun = await tx.stealthGenerationRun.findUnique({
      where: { id: params.runId },
      include: {
        variant: {
          include: {
            credential: true,
            model: true,
          },
        },
      },
    });
    if (!currentRun) throw new Error("Generation run not found");
    const currentResult = await tx.stealthGenerationResult.findUnique({
      where: resultKey,
      select: {
        id: true,
        status: true,
        lockedBy: true,
        uploadBucket: true,
        uploadPath: true,
        uploadQueuedAt: true,
      },
    });
    const upload =
      currentResult?.uploadBucket && currentResult.uploadPath && currentResult.uploadQueuedAt
        ? { bucket: currentResult.uploadBucket, path: currentResult.uploadPath }
        : null;
    const sourceReady =
      currentRun.variant.source === "UPLOAD"
        ? Boolean(upload)
        : currentRun.variant.endpointEnabled;
    if (
      currentRun.status !== "RUNNING" ||
      !sourceReady ||
      experiment.status === "CLOSED"
    ) {
      return null;
    }
    if (params.workerId) {
      return currentResult?.status === "GENERATING" && currentResult.lockedBy === params.workerId
        ? { ...currentRun, upload, resultId: currentResult.id }
        : null;
    }
    const prior = await tx.stealthGenerationResult.upsert({
      where: resultKey,
      create: { ...resultIdentity, status: "QUEUED" },
      update: {},
      select: { status: true },
    });
    if (prior.status !== "QUEUED") return null;
    const activePromptCount = await tx.stealthGenerationResult.count({
      where: {
        runId: currentRun.id,
        status: { in: ["GENERATING", "VALIDATING"] },
      },
    });
    if (activePromptCount >= generationConcurrency(currentRun.configuration)) return null;
    const claimed = await tx.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "QUEUED" },
      data: { status: "GENERATING", error: null },
    });
    return claimed.count === 1
      ? { ...currentRun, upload, resultId: currentResult?.id ?? "" }
      : null;
  });
  if (!run) return;
  const ownedWhere = (status: "GENERATING" | "VALIDATING") => ({
    ...resultIdentity,
    status,
    ...(params.workerId ? { lockedBy: params.workerId } : {}),
  });

  const existing = await prisma.build.findUnique({
    where: {
      promptId_modelId_gridSize_palette_mode: {
        promptId: entry.prompt.id,
        modelId: run.variant.modelId,
        gridSize: GRID_SIZE,
        palette: PALETTE,
        mode: MODE,
      },
    },
    select: { id: true, generationTimeMs: true },
  });
  if (existing && run.variant.source !== "UPLOAD") {
    try {
      await withStealthGenerationHeartbeat(run.id, entry.prompt.id, async () => {
        await params.acquireBuildProcessing?.();
        throwIfGenerationWorkerLeaseLost(params.signal);
        await ensureStealthBuildArtifacts(existing.id);
      });
      throwIfGenerationWorkerLeaseLost(params.signal);
      const accepted = await acceptStealthGenerationBuild({
        runId: run.id,
        resultIdentity,
        fromStatus: "GENERATING",
        buildId: existing.id,
        attempts: 0,
        generationTimeMs: existing.generationTimeMs,
        requestConfiguration: null,
        workerId: params.workerId,
      });
      if (!accepted) return;
      if (run.upload) await cleanupStealthBuildUpload(run.resultId, run.upload);
      await refreshStealthGenerationProgress(run.id);
      return;
    } catch (error) {
      throwIfGenerationWorkerLeaseLost(params.signal);
      const removedMissingPayload =
        isMissingStealthBuildPayload(error) &&
        (await deleteUnacceptedStealthBuild(existing.id));
      if (!removedMissingPayload) {
        await prisma.stealthGenerationResult.updateMany({
          where: ownedWhere("GENERATING"),
          data: {
            status: "FAILED",
            error: sanitizeOperationalError(error),
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null,
          },
        });
        await refreshStealthGenerationProgress(run.id);
        return;
      }
    }
  }

  if (run.variant.source === "UPLOAD") {
    if (!run.upload) throw new Error("Uploaded build is unavailable");
    let uploadedBuild;
    try {
      uploadedBuild = await withStealthGenerationHeartbeat(run.id, entry.prompt.id, async () => {
        await params.acquireBuildProcessing?.();
        throwIfGenerationWorkerLeaseLost(params.signal);
        return loadStealthBuildUpload(run.upload!, params.signal);
      });
    } catch (error) {
      throwIfGenerationWorkerLeaseLost(params.signal);
      if (!(error instanceof InvalidStealthBuildUploadError)) throw error;
      await prisma.stealthGenerationResult.updateMany({
        where: ownedWhere("GENERATING"),
        data: {
          status: "FAILED",
          error: sanitizeOperationalError(error),
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
        },
      });
      await cleanupStealthBuildUpload(run.resultId, run.upload);
      await refreshStealthGenerationProgress(run.id);
      return;
    }

    const validating = await prisma.stealthGenerationResult.updateMany({
      where: ownedWhere("GENERATING"),
      data: { status: "VALIDATING", error: null },
    });
    if (validating.count !== 1) return;
    const build = await withStealthGenerationHeartbeat(run.id, entry.prompt.id, async () => {
      if (existing) await deleteUnacceptedStealthBuild(existing.id);
      return persistStealthBuild({
        variantId: run.variant.id,
        modelId: run.variant.modelId,
        promptSlug: entry.slug,
        promptText: entry.text,
        build: uploadedBuild,
        generationTimeMs: 0,
      });
    });
    const accepted = await acceptStealthGenerationBuild({
      runId: run.id,
      resultIdentity,
      fromStatus: "VALIDATING",
      buildId: build.id,
      attempts: 0,
      generationTimeMs: 0,
      requestConfiguration: "source=upload",
      workerId: params.workerId,
    });
    if (!accepted && build.created) await deleteUnacceptedStealthBuild(build.id);
    if (accepted) await cleanupStealthBuildUpload(run.resultId, run.upload);
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  if (!run.variant.credential || !run.variant.endpointEnabled) {
    await prisma.stealthGenerationResult.updateMany({
      where: ownedWhere("GENERATING"),
      data: {
        status: "FAILED",
        error: "Endpoint credential is not available",
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  const configuration = run.configuration as { maxAttempts?: number };
  const maxAttempts = Math.max(1, Math.min(MAX_GENERATION_ATTEMPTS, configuration.maxAttempts ?? 3));
  let attempts = 0;
  let configuredSecrets: string[] = [];
  let generated: Awaited<ReturnType<typeof generateVoxelBuild>>;
  try {
    const config = decryptStealthEndpointConfig(run.variant.credential.encryptedConfig);
    configuredSecrets = stealthEndpointSecretValues(config);
    generated = await withStealthGenerationHeartbeat(run.id, entry.prompt.id, () =>
      generateVoxelBuild({
        ...stealthEndpointConfigToGenerateVoxelBuildArgs(config, {
          key: run.variant.model.key,
          displayName: run.variant.codename,
        }),
        prompt: entry.text,
        gridSize: GRID_SIZE,
        palette: PALETTE,
        maxAttempts,
        returnExpandedBuild: true,
        abortSignal: generationProviderSignal(params.signal),
        acquireBuildProcessing: params.acquireBuildProcessing,
        onProviderRequest: (attempt) => {
          attempts = Math.max(attempts, attempt);
        },
        onRetry: (attempt) => {
          attempts = Math.max(attempts, attempt);
        },
      }),
    );
    throwIfGenerationWorkerLeaseLost(params.signal);
  } catch (error) {
    throwIfGenerationWorkerLeaseLost(params.signal);
    await prisma.stealthGenerationResult.updateMany({
      where: ownedWhere("GENERATING"),
      data: {
        status: "FAILED",
        attempts,
        error: sanitizeOperationalError(error, configuredSecrets),
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  if (!generated.ok) {
    await prisma.stealthGenerationResult.updateMany({
      where: ownedWhere("GENERATING"),
      data: {
        status: "FAILED",
        attempts,
        generationTimeMs: generated.generationTimeMs,
        requestConfiguration: generated.requestConfiguration,
        error: sanitizeOperationalError(
          generated.error,
          configuredSecrets,
        ),
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  const validating = await prisma.$transaction(async (tx) => {
    const experiment = await lockGenerationContext(tx, run.id);
    if (!experiment) return 0;
    const current = await tx.stealthGenerationRun.findUnique({
      where: { id: run.id },
      select: {
        status: true,
        variant: {
          select: {
            endpointEnabled: true,
          },
        },
      },
    });
    if (
      !current ||
      current.status !== "RUNNING" ||
      !current.variant.endpointEnabled ||
      experiment.status === "CLOSED"
    ) {
      return 0;
    }
    const updated = await tx.stealthGenerationResult.updateMany({
      where: ownedWhere("GENERATING"),
      data: {
        status: "VALIDATING",
        attempts,
        generationTimeMs: generated.generationTimeMs,
        requestConfiguration: generated.requestConfiguration,
        error: null,
      },
    });
    return updated.count;
  });
  if (validating !== 1) return;

  try {
    const build = await withStealthGenerationHeartbeat(run.id, entry.prompt.id, () =>
      persistStealthBuild({
        variantId: run.variant.id,
        modelId: run.variant.modelId,
        promptSlug: entry.slug,
        promptText: entry.text,
        build: generated.build,
        generationTimeMs: generated.generationTimeMs,
      }),
    );
    const accepted = await acceptStealthGenerationBuild({
      runId: run.id,
      resultIdentity,
      fromStatus: "VALIDATING",
      buildId: build.id,
      attempts,
      generationTimeMs: generated.generationTimeMs,
      requestConfiguration: generated.requestConfiguration ?? null,
      workerId: params.workerId,
    });
    if (!accepted && build.created) await deleteUnacceptedStealthBuild(build.id);
  } catch (error) {
    throwIfGenerationWorkerLeaseLost(params.signal);
    await prisma.stealthGenerationResult.updateMany({
      where: ownedWhere("VALIDATING"),
      data: {
        status: "FAILED",
        attempts,
        generationTimeMs: generated.generationTimeMs,
        requestConfiguration: generated.requestConfiguration,
        error: sanitizeOperationalError(error),
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
  }
  await refreshStealthGenerationProgress(run.id);
}

async function refreshStealthGenerationProgress(runId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const experiment = await lockGenerationContext(tx, runId);
    if (!experiment) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        variantId: true,
        status: true,
      },
    });
    if (!run || run.status !== "RUNNING") return;
    const results = await tx.stealthGenerationResult.findMany({
      where: { runId },
      orderBy: { updatedAt: "asc" },
      select: { status: true, attempts: true, error: true },
    });
    const progress = summarizeGenerationResults(results);
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        completedBuildCount: progress.completedBuildCount,
        failedBuildCount: progress.failedBuildCount,
        providerCallCount: progress.providerCallCount,
        retryCount: progress.retryCount,
        error: progress.lastError,
      },
    });
    if (experiment.status !== "CLOSED") {
      await tx.stealthVariant.updateMany({
        where: { id: run.variantId, status: { not: "WITHDRAWN" } },
        data: {
          generatedBuildCount: progress.completedBuildCount,
          generationFailureCount: progress.failedBuildCount,
          lastGenerationError: progress.lastError,
        },
      });
    }
  });
}

export async function finishStealthGenerationRun(runId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const experiment = await lockGenerationContext(tx, runId);
    if (!experiment) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      include: { variant: true },
    });
    if (!run || run.status !== "RUNNING") return;
    const results = await tx.stealthGenerationResult.findMany({
      where: { runId: run.id },
      orderBy: { updatedAt: "asc" },
      select: { status: true, attempts: true, error: true },
    });
    const progress = summarizeGenerationResults(results);
    const runProgress = {
      completedBuildCount: progress.completedBuildCount,
      failedBuildCount: progress.failedBuildCount,
      providerCallCount: progress.providerCallCount,
      retryCount: progress.retryCount,
      error: progress.lastError,
    };
    const variantProgress = {
      generatedBuildCount: progress.completedBuildCount,
      generationFailureCount: progress.failedBuildCount,
      lastGenerationError: progress.lastError,
    };
    if (progress.unfinishedPromptCount > 0) {
      await tx.stealthGenerationRun.update({ where: { id: run.id }, data: runProgress });
      if (experiment.status !== "CLOSED") {
        await tx.stealthVariant.updateMany({
          where: { id: run.variantId, status: { not: "WITHDRAWN" } },
          data: variantProgress,
        });
      }
      return;
    }
    const complete =
      progress.completedBuildCount === run.expectedBuildCount && progress.failedBuildCount === 0;
    if (run.variant.source === "UPLOAD" && !complete) {
      await tx.stealthGenerationRun.update({ where: { id: run.id }, data: runProgress });
      if (experiment.status !== "CLOSED") {
        await tx.stealthVariant.updateMany({
          where: { id: run.variantId, status: { not: "WITHDRAWN" } },
          data: {
            ...variantProgress,
            status: progress.completedBuildCount > 0 ? "GENERATING" : "DRAFT",
          },
        });
        await syncExperimentReadiness(tx, run.variant.experimentId);
      }
      return;
    }
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        ...runProgress,
        status: complete ? "SUCCEEDED" : progress.completedBuildCount > 0 ? "PARTIAL" : "FAILED",
        completedAt: new Date(),
      },
    });
    if (experiment.status === "CLOSED") {
      if (complete) {
        await tx.stealthEndpointCredential.deleteMany({ where: { variantId: run.variantId } });
      }
      return;
    }
    await tx.stealthVariant.updateMany({
      where: { id: run.variantId, status: { not: "WITHDRAWN" } },
      data: {
        ...variantProgress,
        status: complete ? "READY" : progress.completedBuildCount > 0 ? "GENERATING" : "DRAFT",
        endpointEnabled: !complete,
        cohortGeneratedAt: complete ? new Date() : null,
      },
    });
    if (complete) {
      await tx.stealthEndpointCredential.deleteMany({ where: { variantId: run.variantId } });
    }
    await syncExperimentReadiness(tx, run.variant.experimentId);
  });
}
