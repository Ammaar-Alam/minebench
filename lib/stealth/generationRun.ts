import { Prisma } from "@prisma/client";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { BENCHMARK_PROMPT_COHORT_ID } from "@/lib/benchmark/prompts";
import { prisma } from "@/lib/prisma";
import {
  decryptStealthEndpointConfig,
  stealthEndpointConfigToGenerateVoxelBuildArgs,
} from "@/lib/stealth/credentials";
import {
  ensureStealthBuildArtifacts,
  persistStealthBuild,
} from "@/lib/stealth/generation";
import {
  prepareStealthCohortPrompts,
  STEALTH_COHORT_BUILD,
  type CohortPrompt,
} from "@/lib/stealth/cohort";
import {
  assertEvaluationOperator,
  isStealthCheckpointSetOpen,
  lockExperiment,
  lockVariant,
  sanitizeOperationalError,
  syncExperimentReadiness,
  type StealthActor,
} from "@/lib/stealth/service";

const MAX_GENERATION_ATTEMPTS = 10;
const MAX_GENERATION_CONCURRENCY = 4;
const { gridSize: GRID_SIZE, palette: PALETTE, mode: MODE } = STEALTH_COHORT_BUILD;

export type StealthGenerationLauncher = (runId: string) => Promise<string>;

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

async function countCompletedBuilds(
  db: Prisma.TransactionClient,
  modelId: string,
  prompts: CohortPrompt[],
): Promise<number> {
  return db.build.count({
    where: {
      modelId,
      gridSize: GRID_SIZE,
      palette: PALETTE,
      mode: MODE,
      prompt: { text: { in: prompts.map((prompt) => prompt.text) } },
    },
  });
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

  return prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const variant = await lockVariant(tx, variantId);
    if (!variant) throw new Error("Checkpoint not found");
    const experiment = await lockExperiment(tx, variant.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Checkpoint not found");
    }
    if (experiment.status === "CLOSED") throw new Error("Closed evaluations are read-only");
    if (!isStealthCheckpointSetOpen(experiment.status)) {
      throw new Error("Only draft evaluations can generate builds");
    }
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
    const completedBuildCount = await countCompletedBuilds(tx, variant.modelId, prompts);
    if (completedBuildCount === prompts.length) throw new Error("The cohort is already complete");

    const config = decryptStealthEndpointConfig(withCredential.credential.encryptedConfig);
    const existingBuilds = await tx.build.findMany({
      where: {
        modelId: variant.modelId,
        gridSize: GRID_SIZE,
        palette: PALETTE,
        mode: MODE,
        prompt: { text: { in: prompts.map((prompt) => prompt.text) } },
      },
      select: { id: true, promptId: true },
    });
    const buildByPromptId = new Map(existingBuilds.map((build) => [build.promptId, build.id]));
    const run = await tx.stealthGenerationRun.create({
      data: {
        variantId: variant.id,
        status: "RUNNING",
        promptCohortId: BENCHMARK_PROMPT_COHORT_ID,
        expectedBuildCount: prompts.length,
        completedBuildCount: existingBuilds.length,
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
              buildId: buildByPromptId.get(prompt.prompt.id) ?? null,
              status: buildByPromptId.has(prompt.prompt.id) ? "READY" : "QUEUED",
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
        generatedBuildCount: existingBuilds.length,
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

async function attachWorkflowRunId(runId: string, workflowRunId: string): Promise<void> {
  await prisma.stealthGenerationRun.update({
    where: { id: runId },
    data: { workflowRunId },
  });
}

export async function startStealthGeneration(
  actor: StealthActor,
  organizationId: string,
  variantId: string,
  params: { maxAttempts: number; concurrency: number },
  launch: StealthGenerationLauncher,
): Promise<{ runId: string; workflowRunId: string }> {
  const { runId } = await createStealthGenerationRun(actor, organizationId, variantId, params);
  try {
    const workflowRunId = (await launch(runId)).trim();
    if (!workflowRunId) throw new Error("Workflow run id is required");
    await attachWorkflowRunId(runId, workflowRunId);
    return { runId, workflowRunId };
  } catch (error) {
    await failStealthGenerationRun(runId, error);
    throw new Error(sanitizeOperationalError(error));
  }
}

export async function getStealthGenerationPlan(
  runId: string,
): Promise<{ promptBatches: string[][] } | null> {
  const run = await prisma.stealthGenerationRun.findUnique({
    where: { id: runId },
    select: { status: true, configuration: true },
  });
  if (!run) throw new Error("Generation run not found");
  if (run.status !== "RUNNING") return null;
  const configured = (run.configuration as { concurrency?: unknown }).concurrency;
  const concurrency =
    typeof configured === "number" && Number.isInteger(configured)
      ? Math.max(1, Math.min(MAX_GENERATION_CONCURRENCY, configured))
      : 1;
  const promptSlugs = (await prepareStealthCohortPrompts()).map((prompt) => prompt.slug);
  const promptBatches: string[][] = [];
  for (let index = 0; index < promptSlugs.length; index += concurrency) {
    promptBatches.push(promptSlugs.slice(index, index + concurrency));
  }
  return { promptBatches };
}

export async function failStealthGenerationRun(runId: string, error: unknown): Promise<void> {
  const message = sanitizeOperationalError(error);
  await prisma.$transaction(async (tx) => {
    const locked = await lockGenerationRun(tx, runId);
    if (!locked) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      include: { variant: { include: { experiment: true } } },
    });
    if (!run || run.status !== "RUNNING") return;
    await tx.stealthGenerationResult.updateMany({
      where: { runId: run.id, status: { in: ["QUEUED", "GENERATING", "VALIDATING"] } },
      data: { status: "FAILED", error: message },
    });
    const results = await tx.stealthGenerationResult.findMany({
      where: { runId: run.id },
      select: { status: true, attempts: true, error: true },
    });
    const completedBuildCount = results.filter((result) => result.status === "READY").length;
    const failedBuildCount = results.filter((result) => result.status === "FAILED").length;
    const providerCallCount = results.reduce((sum, result) => sum + result.attempts, 0);
    const retryCount = results.reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0);
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        status: completedBuildCount > 0 ? "PARTIAL" : "FAILED",
        completedBuildCount,
        failedBuildCount,
        providerCallCount,
        retryCount,
        error: message,
        completedAt: new Date(),
      },
    });
    if (run.variant.experiment.status !== "CLOSED") {
      await tx.stealthVariant.update({
        where: { id: run.variantId },
        data: {
          status: completedBuildCount > 0 ? "GENERATING" : "DRAFT",
          generatedBuildCount: completedBuildCount,
          generationFailureCount: failedBuildCount,
          lastGenerationError: message,
        },
      });
      await syncExperimentReadiness(tx, run.variant.experimentId);
    }
  });
}

export async function generateStealthPromptForRun(params: {
  runId: string;
  promptSlug: string;
}): Promise<void> {
  const prompts = await prepareStealthCohortPrompts();
  const entry = prompts.find((prompt) => prompt.slug === params.promptSlug);
  if (!entry) throw new Error("Prompt not found");
  const resultIdentity = { runId: params.runId, promptId: entry.prompt.id };
  const resultKey = { runId_promptId: resultIdentity };

  const run = await prisma.$transaction(async (tx) => {
    const locked = await lockGenerationRun(tx, params.runId);
    if (!locked) throw new Error("Generation run not found");
    const currentRun = await tx.stealthGenerationRun.findUnique({
      where: { id: params.runId },
      include: {
        variant: {
          include: {
            credential: true,
            model: true,
            experiment: { select: { id: true, status: true } },
          },
        },
      },
    });
    if (!currentRun) throw new Error("Generation run not found");
    if (currentRun.status !== "RUNNING" || currentRun.variant.experiment.status === "CLOSED") {
      return null;
    }
    const prior = await tx.stealthGenerationResult.upsert({
      where: resultKey,
      create: { ...resultIdentity, status: "QUEUED" },
      update: {},
      select: { status: true },
    });
    if (prior.status !== "QUEUED") return null;
    const claimed = await tx.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "QUEUED" },
      data: { status: "GENERATING", error: null },
    });
    return claimed.count === 1 ? currentRun : null;
  });
  if (!run) return;

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
    select: { id: true },
  });
  if (existing) {
    try {
      await ensureStealthBuildArtifacts(existing.id);
      await prisma.stealthGenerationResult.updateMany({
        where: { ...resultIdentity, status: "GENERATING" },
        data: {
          buildId: existing.id,
          status: "READY",
          attempts: 0,
          generationTimeMs: 0,
          error: null,
        },
      });
    } catch (error) {
      await prisma.stealthGenerationResult.updateMany({
        where: { ...resultIdentity, status: "GENERATING" },
        data: { status: "FAILED", error: sanitizeOperationalError(error) },
      });
    }
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  if (!run.variant.credential || !run.variant.endpointEnabled) {
    await prisma.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "GENERATING" },
      data: { status: "FAILED", error: "Endpoint credential is not available" },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  const configuration = run.configuration as { maxAttempts?: number };
  const maxAttempts = Math.max(1, Math.min(MAX_GENERATION_ATTEMPTS, configuration.maxAttempts ?? 3));
  let attempts = 0;
  let generated: Awaited<ReturnType<typeof generateVoxelBuild>>;
  try {
    const config = decryptStealthEndpointConfig(run.variant.credential.encryptedConfig);
    generated = await generateVoxelBuild({
      ...stealthEndpointConfigToGenerateVoxelBuildArgs(config, {
        key: run.variant.model.key,
        displayName: run.variant.codename,
      }),
      prompt: entry.text,
      gridSize: GRID_SIZE,
      palette: PALETTE,
      maxAttempts,
      onProviderRequest: (attempt) => {
        attempts = Math.max(attempts, attempt);
      },
      onRetry: (attempt) => {
        attempts = Math.max(attempts, attempt);
      },
    });
  } catch (error) {
    await prisma.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "GENERATING" },
      data: { status: "FAILED", attempts, error: sanitizeOperationalError(error) },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  if (!generated.ok) {
    await prisma.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "GENERATING" },
      data: {
        status: "FAILED",
        attempts,
        generationTimeMs: generated.generationTimeMs,
        requestConfiguration: generated.requestConfiguration,
        error: sanitizeOperationalError(generated.error),
      },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  const validating = await prisma.stealthGenerationResult.updateMany({
    where: { ...resultIdentity, status: "GENERATING" },
    data: {
      status: "VALIDATING",
      attempts,
      generationTimeMs: generated.generationTimeMs,
      requestConfiguration: generated.requestConfiguration,
      error: null,
    },
  });
  if (validating.count !== 1) return;

  try {
    const build = await persistStealthBuild({
      variantId: run.variant.id,
      modelId: run.variant.modelId,
      promptSlug: entry.slug,
      promptText: entry.text,
      build: generated.build,
      generationTimeMs: generated.generationTimeMs,
    });
    await prisma.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "VALIDATING" },
      data: {
        buildId: build.id,
        status: "READY",
        attempts,
        generationTimeMs: generated.generationTimeMs,
        requestConfiguration: generated.requestConfiguration,
        error: null,
      },
    });
  } catch (error) {
    await prisma.stealthGenerationResult.updateMany({
      where: { ...resultIdentity, status: "VALIDATING" },
      data: {
        status: "FAILED",
        attempts,
        generationTimeMs: generated.generationTimeMs,
        requestConfiguration: generated.requestConfiguration,
        error: sanitizeOperationalError(error),
      },
    });
  }
  await refreshStealthGenerationProgress(run.id);
}

async function refreshStealthGenerationProgress(runId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await lockGenerationRun(tx, runId);
    if (!locked) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      select: { id: true, variantId: true, status: true },
    });
    if (!run || run.status !== "RUNNING") return;
    const results = await tx.stealthGenerationResult.findMany({
      where: { runId },
      orderBy: { updatedAt: "asc" },
      select: { status: true, attempts: true, error: true },
    });
    const completedBuildCount = results.filter((result) => result.status === "READY").length;
    const failedBuildCount = results.filter((result) => result.status === "FAILED").length;
    const providerCallCount = results.reduce((sum, result) => sum + result.attempts, 0);
    const retryCount = results.reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0);
    const lastError = [...results].reverse().find((result) => result.error)?.error ?? null;
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: { completedBuildCount, failedBuildCount, providerCallCount, retryCount, error: lastError },
    });
    await tx.stealthVariant.update({
      where: { id: run.variantId },
      data: {
        generatedBuildCount: completedBuildCount,
        generationFailureCount: failedBuildCount,
        lastGenerationError: lastError,
      },
    });
  });
}

export async function finishStealthGenerationRun(runId: string): Promise<void> {
  await refreshStealthGenerationProgress(runId);
  await prisma.$transaction(async (tx) => {
    const locked = await lockGenerationRun(tx, runId);
    if (!locked) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      include: { variant: { include: { experiment: true } } },
    });
    if (!run || run.status !== "RUNNING") return;
    const complete = run.completedBuildCount === run.expectedBuildCount && run.failedBuildCount === 0;
    await tx.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        status: complete ? "SUCCEEDED" : run.completedBuildCount > 0 ? "PARTIAL" : "FAILED",
        completedAt: new Date(),
      },
    });
    if (run.variant.experiment.status === "CLOSED") {
      if (complete) {
        await tx.stealthEndpointCredential.deleteMany({ where: { variantId: run.variantId } });
      }
      return;
    }
    await tx.stealthVariant.update({
      where: { id: run.variantId },
      data: {
        status: complete ? "READY" : "GENERATING",
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
