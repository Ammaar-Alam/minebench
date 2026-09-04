import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type OrganizationRole,
  type StealthExportPolicy,
  type StealthExperimentStatus,
  type StealthGenerationResultStatus,
  type StealthVariantStatus,
} from "@prisma/client";
import { deleteArenaBuildArtifacts } from "@/lib/arena/artifactOwnership";
import {
  BENCHMARK_PROMPT_COHORT_ID,
  BENCHMARK_PROMPT_MAP,
} from "@/lib/benchmark/prompts";
import { prisma } from "@/lib/prisma";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  assertSupabaseStorageObjectExists,
  createSupabaseSignedUploadToken,
  deleteSupabaseStorageObjects,
  getBuildStorageBucketFromEnv,
  getSupabaseStorageConfig,
  hasSupabaseStorageConfig,
} from "@/lib/storage/buildPayload";
import {
  encryptStealthEndpointConfig,
  type StealthEndpointConfig,
} from "@/lib/stealth/credentials";
import {
  getStealthBuildStoragePrefix,
} from "@/lib/stealth/generation";
import {
  prepareStealthCohortPrompts,
  STEALTH_COHORT_BUILD,
} from "@/lib/stealth/cohort";
import {
  normalizeStealthSlug,
  opaqueStealthModelKey,
} from "@/lib/stealth/policy";
import { invalidateStealthSamplingCache } from "@/lib/stealth/sampling";
import { readableStealthEvaluationWhere } from "@/lib/stealth/retention";

export type StealthActor =
  | { organizationUser: { userId: string } }
  | { minebenchAdmin: true };

export type CreateStealthEvaluationInput = {
  name: string;
  slug?: string;
  targetDecisiveVotes?: number | null;
  pauseAtGoal?: boolean;
  exportPolicy?: StealthExportPolicy;
  retentionDays?: number;
  agreementReference?: string | null;
};

export type UpdateStealthEvaluationInput = Partial<CreateStealthEvaluationInput>;

export type ConfigureStealthEndpointInput = {
  variantId?: string;
  codename: string;
  config: StealthEndpointConfig;
};

export type CreateStealthUploadCheckpointInput = {
  variantId?: string;
  codename: string;
};

export type StealthBuildUploadTarget = {
  resultId: string;
  bucket: string;
  path: string;
  endpoint: string;
  token: string;
};

export type ProvisionStealthOrganizationInput = {
  name: string;
  slug: string;
  initialAdminEmail: string;
};

export type RecordStealthReleaseMappingInput = {
  variantId: string;
  checkpointCodename: string;
  publicModelKey: string;
};

export type StealthOrganizationAdminListItem = {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  adminEmails: string[];
  evaluationCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StealthOrganizationAdminDetail = StealthOrganizationAdminListItem & {
  memberships: Array<{ email: string; displayName: string | null; role: OrganizationRole }>;
  pendingInvitations: Array<{ email: string; role: OrganizationRole; createdAt: Date }>;
};

export type StealthEvaluationWorkspaceListItem = {
  id: string;
  slug: string;
  name: string;
  status: StealthExperimentStatus;
  checkpointCount: number;
  buildProgress: { completed: number; expected: number };
  voteProgress: { decisiveVotes: number; targetDecisiveVotes: number | null };
  updatedAt: Date;
};

export type StealthEvaluationWorkspace = {
  id: string;
  slug: string;
  name: string;
  status: StealthExperimentStatus;
  exportPolicy: StealthExportPolicy;
  targetDecisiveVotes: number | null;
  pauseAtGoal: boolean;
  retentionDays: number;
  agreementReference: string | null;
  startsAt: Date | null;
  checkpointSetFrozenAt: Date | null;
  endedAt: Date | null;
  retentionDeleteAt: Date | null;
  organization: { id: string; slug: string; name: string };
  checkpoints: Array<{
    id: string;
    codename: string;
    source: string;
    status: StealthVariantStatus;
    endpointEnabled: boolean;
    credentialConfigured: boolean;
    expectedBuildCount: number;
    generatedBuildCount: number;
    persistedBuildCount: number;
    generationFailureCount: number;
    lastGenerationError: string | null;
    cohortGeneratedAt: Date | null;
    decisiveVotes: number;
    totalVotes: number;
    latestGenerationRun: {
      id: string;
      status: string;
      promptCohortId: string;
      workflowRunId: string | null;
      completedBuildCount: number;
      expectedBuildCount: number;
      failedBuildCount: number;
      providerCallCount: number;
      retryCount: number;
      startedAt: Date;
      completedAt: Date | null;
      error: string | null;
      results: Array<{
        resultId: string;
        promptId: string;
        prompt: string;
        status: StealthGenerationResultStatus;
        attempts: number;
        generationTimeMs: number;
        requestConfiguration: string | null;
        error: string | null;
        uploadPending: boolean;
        build: {
          blockCount: number;
        } | null;
      }>;
    } | null;
    promptCohortCurrent: boolean;
    currentExpectedBuildCount: number;
    currentGeneratedBuildCount: number;
  }>;
};

type PrismaExecutor = typeof prisma | Prisma.TransactionClient;
const GENERATION_LEASE_MS = 15 * 60_000;
const GENERATION_HEARTBEAT_MS = 30_000;

type OrganizationAccess = {
  role: OrganizationRole | "MINEBENCH_ADMIN";
  minebenchAdmin: boolean;
  organization: { id: string; slug: string; name: string };
};

type LockedExperiment = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  status: StealthExperimentStatus;
  targetDecisiveVotes: number | null;
  pauseAtGoal: boolean;
  retentionDays: number;
  startsAt: Date | null;
  checkpointSetFrozenAt: Date | null;
  endedAt: Date | null;
  retentionDeleteAt: Date | null;
};

type LockedVariant = {
  id: string;
  experimentId: string;
  codename: string;
  source: string;
  status: StealthVariantStatus;
  modelId: string;
  endpointEnabled: boolean;
  expectedBuildCount: number;
  generatedBuildCount: number;
  generationFailureCount: number;
  cohortGeneratedAt: Date | null;
  checkpointFingerprint: string | null;
  releasedModelId: string | null;
  releasedAt: Date | null;
};

const { gridSize: GRID_SIZE, palette: PALETTE, mode: MODE } = STEALTH_COHORT_BUILD;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const BUILD_UPLOAD_PREFIX = "stealth-build-uploads/v1";
const BUILD_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const CONFIGURABLE_EXPERIMENT_STATUSES: readonly StealthExperimentStatus[] = [
  "DRAFT",
  "GENERATING",
  "READY",
];
const CONFIGURABLE_VARIANT_STATUSES: readonly StealthVariantStatus[] = ["DRAFT", "GENERATING"];

export function isStealthCheckpointSetOpen(status: StealthExperimentStatus): boolean {
  return CONFIGURABLE_EXPERIMENT_STATUSES.includes(status);
}

function isMineBenchAdmin(actor: StealthActor): actor is { minebenchAdmin: true } {
  return "minebenchAdmin" in actor && actor.minebenchAdmin === true;
}

function organizationUserId(actor: StealthActor): string | null {
  return "organizationUser" in actor ? actor.organizationUser.userId.trim() || null : null;
}

function assertMineBenchAdminActor(actor: StealthActor): void {
  if (!isMineBenchAdmin(actor)) throw new Error("MineBench admin access is required");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("Enter a valid email");
  }
  return normalized;
}

function normalizeName(value: string, label: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeRole(role: OrganizationRole): OrganizationRole {
  if (role !== "ADMIN" && role !== "MEMBER") throw new Error("Invalid role");
  return role;
}

function normalizePositiveInt(
  value: number | null | undefined,
  label: string,
  max: number,
): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be from 1 to ${max}`);
  }
  return value;
}

function normalizeRetentionDays(value: number | null | undefined): number {
  if (value == null) return DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RETENTION_DAYS) {
    throw new Error(`Retention must be from 1 to ${MAX_RETENTION_DAYS} days`);
  }
  return value;
}

function normalizeExportPolicy(value: StealthExportPolicy | undefined): StealthExportPolicy {
  if (!value) return "AGGREGATES_ONLY";
  if (value !== "AGGREGATES_ONLY" && value !== "DEIDENTIFIED_VOTES") {
    throw new Error("Invalid export policy");
  }
  return value;
}

function safeText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ").slice(0, maxLength) ?? "";
  return normalized || null;
}

export function sanitizeOperationalError(
  error: unknown,
  exactSecrets: readonly string[] = [],
): string {
  let raw = error instanceof Error ? error.message : String(error || "Operation failed");
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"error"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string } | string };
      const innerMsg =
        typeof parsed.error === "object" && parsed.error?.message
          ? parsed.error.message
          : typeof parsed.error === "string"
            ? parsed.error
            : null;
      if (innerMsg) {
        raw = raw.replace(jsonMatch[0], innerMsg);
      }
    }
  } catch {
    // keep raw if not parseable
  }

  raw = raw.replace(/^OpenRouter request failed:\s*(OpenRouter (?:error|HTTP) \d+:)/i, "$1");

  const exactRedacted = exactSecrets.reduce(
    (message, secret) => (secret ? message.split(secret).join("[redacted]") : message),
    raw,
  );
  const redacted = exactRedacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|authorization|x-api-key|key)["'\s:=]+[A-Za-z0-9._~+/-]+=*/gi,
      "$1=[redacted]",
    )
    .replace(
      /https?:\/\/(?!(?:openrouter\.ai|platform\.openai\.com|docs\.anthropic\.com|ai\.google\.dev)\/)[^\s"'`]+/gi,
      "[endpoint]",
    )
    .replace(/stealth-builds\/v\d+\/[^\s"'`]+/gi, "[private storage object]")
    .replace(/arena-(snapshot|stream)\/[^\s"'`]+/gi, "[private artifact]")
    .replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[encrypted value]")
    .trim();
  return (redacted || "Operation failed").slice(0, 4000);
}

function checkpointFingerprint(endpointUrl: string, modelId: string): string {
  return createHash("sha256")
    .update(`${endpointUrl.trim().replace(/\/+$/, "")}\n${modelId.trim()}`)
    .digest("hex");
}

async function authorizeOrganization(
  db: PrismaExecutor,
  actor: StealthActor,
  organizationId: string,
  permission: "member" | "admin",
): Promise<OrganizationAccess> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, slug: true, name: true },
  });
  if (!organization) throw new Error("Organization not found");

  if (isMineBenchAdmin(actor)) {
    return {
      role: "MINEBENCH_ADMIN",
      minebenchAdmin: true,
      organization,
    };
  }

  const userId = organizationUserId(actor);
  if (!userId) throw new Error("Sign in again");
  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (!membership) throw new Error("Organization access is required");
  if (permission === "admin" && membership.role !== "ADMIN") {
    throw new Error("Admin access is required");
  }
  return {
    role: membership.role,
    minebenchAdmin: false,
    organization,
  };
}

async function assertOrganizationAdmin(
  db: PrismaExecutor,
  actor: StealthActor,
  organizationId: string,
): Promise<OrganizationAccess> {
  return authorizeOrganization(db, actor, organizationId, "admin");
}

export async function assertEvaluationOperator(
  db: PrismaExecutor,
  actor: StealthActor,
  organizationId: string,
): Promise<OrganizationAccess> {
  return authorizeOrganization(db, actor, organizationId, "member");
}

async function assertNotLastAdmin(
  db: PrismaExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (membership?.role !== "ADMIN") return;
  const otherAdmins = await db.organizationMembership.count({
    where: {
      organizationId,
      role: "ADMIN",
      userId: { not: userId },
    },
  });
  if (otherAdmins === 0) throw new Error("An organization must keep at least one Admin");
}

async function lockOrganization(
  db: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "Organization"
    WHERE id = ${organizationId}
    FOR UPDATE
  `);
  if (rows.length === 0) throw new Error("Organization not found");
}

async function lockOrganizationMembershipChange(
  db: Prisma.TransactionClient,
  actor: StealthActor,
  organizationId: string,
): Promise<void> {
  await lockOrganization(db, organizationId);
  await assertOrganizationAdmin(db, actor, organizationId);
}

export async function lockExperiment(
  db: Prisma.TransactionClient,
  experimentId: string,
): Promise<LockedExperiment | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "StealthExperiment"
    WHERE id = ${experimentId}
    FOR UPDATE
  `);
  if (rows.length === 0) return null;
  return db.stealthExperiment.findUnique({
    where: { id: experimentId },
    select: {
      id: true,
      organizationId: true,
      slug: true,
      name: true,
      status: true,
      targetDecisiveVotes: true,
      pauseAtGoal: true,
      retentionDays: true,
      startsAt: true,
      checkpointSetFrozenAt: true,
      endedAt: true,
      retentionDeleteAt: true,
    },
  });
}

export async function lockVariant(
  db: Prisma.TransactionClient,
  variantId: string,
): Promise<LockedVariant | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "StealthVariant"
    WHERE id = ${variantId}
    FOR UPDATE
  `);
  if (rows.length === 0) return null;
  return db.stealthVariant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      experimentId: true,
      codename: true,
      source: true,
      status: true,
      modelId: true,
      endpointEnabled: true,
      expectedBuildCount: true,
      generatedBuildCount: true,
      generationFailureCount: true,
      cohortGeneratedAt: true,
      checkpointFingerprint: true,
      releasedModelId: true,
      releasedAt: true,
    },
  });
}

async function lockVariantByCodename(
  db: Prisma.TransactionClient,
  experimentId: string,
  codename: string,
): Promise<LockedVariant | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "StealthVariant"
    WHERE "experimentId" = ${experimentId} AND codename = ${codename}
    FOR UPDATE
  `);
  if (rows.length === 0) return null;
  return lockVariant(db, rows[0].id);
}

export async function reclaimStaleStealthGenerationRuns(
  db: Prisma.TransactionClient,
  variantId: string,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - GENERATION_LEASE_MS);
  const staleRuns = await db.stealthGenerationRun.findMany({
    where: {
      variantId,
      status: "RUNNING",
      startedAt: { lte: cutoff },
      results: {
        none: { status: { in: ["QUEUED", "GENERATING", "VALIDATING"] } },
      },
      NOT: { variant: { source: "UPLOAD" }, results: { some: { status: "FAILED" } } },
    },
    select: {
      id: true,
      expectedBuildCount: true,
      variantId: true,
      variant: { select: { experimentId: true } },
    },
  });
  const completedExperimentIds = new Set<string>();
  for (const run of staleRuns) {
    await db.stealthGenerationResult.updateMany({
      where: { runId: run.id, status: { in: ["QUEUED", "GENERATING", "VALIDATING"] } },
      data: {
        status: "FAILED",
        error: "Generation reservation expired",
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    const completedBuildCount = await db.stealthGenerationResult.count({
      where: { runId: run.id, status: "READY" },
    });
    const complete = completedBuildCount === run.expectedBuildCount;
    await db.stealthGenerationRun.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: {
        status: complete ? "SUCCEEDED" : completedBuildCount > 0 ? "PARTIAL" : "FAILED",
        completedBuildCount,
        failedBuildCount: run.expectedBuildCount - completedBuildCount,
        completedAt: now,
        error: complete ? null : "Generation reservation expired",
      },
    });
    if (complete) {
      await db.stealthVariant.updateMany({
        where: { id: run.variantId, status: { not: "WITHDRAWN" } },
        data: {
          status: "READY",
          endpointEnabled: false,
          expectedBuildCount: run.expectedBuildCount,
          generatedBuildCount: completedBuildCount,
          generationFailureCount: 0,
          cohortGeneratedAt: now,
          lastGenerationError: null,
        },
      });
      await db.stealthEndpointCredential.deleteMany({ where: { variantId: run.variantId } });
    } else {
      await db.stealthVariant.updateMany({
        where: { id: run.variantId, status: { not: "WITHDRAWN" } },
        data: {
          status: completedBuildCount > 0 ? "GENERATING" : "DRAFT",
          generatedBuildCount: completedBuildCount,
          generationFailureCount: run.expectedBuildCount - completedBuildCount,
          lastGenerationError: "Generation reservation expired",
        },
      });
    }
    completedExperimentIds.add(run.variant.experimentId);
  }
  for (const experimentId of completedExperimentIds) {
    await syncExperimentReadiness(db, experimentId);
  }
  return staleRuns.length;
}

export async function withStealthGenerationHeartbeat<T>(
  runId: string,
  promptId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    void prisma.stealthGenerationResult
      .updateMany({
        where: { runId, promptId, status: { in: ["GENERATING", "VALIDATING"] } },
        data: { updatedAt: new Date() },
      })
      .catch(() => undefined);
  }, GENERATION_HEARTBEAT_MS);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

async function assertCheckpointRetryable(
  db: Prisma.TransactionClient,
  variantId: string,
): Promise<void> {
  await reclaimStaleStealthGenerationRuns(db, variantId);
  const activeRunCount = await db.stealthGenerationRun.count({
    where: { variantId, status: "RUNNING" },
  });
  if (activeRunCount > 0) throw new Error("Generation is still running");
  await assertCheckpointUnvoted(db, variantId);
}

async function assertCheckpointUnvoted(
  db: Prisma.TransactionClient,
  variantId: string,
): Promise<void> {
  const [matchupCount, voteCount] = await Promise.all([
    db.matchup.count({ where: { stealthVariantId: variantId } }),
    db.vote.count({ where: { matchup: { stealthVariantId: variantId } } }),
  ]);
  if (matchupCount > 0 || voteCount > 0) {
    throw new Error("A checkpoint with votes is immutable");
  }
}

async function assertNoCheckpointData(
  db: Prisma.TransactionClient,
  variantId: string,
  modelId: string,
): Promise<void> {
  await assertCheckpointRetryable(db, variantId);
  if (await db.build.count({ where: { modelId } })) {
    throw new Error("A checkpoint with builds or votes is immutable");
  }
}

async function purgeDraftCheckpointBuilds(
  db: Prisma.TransactionClient,
  variantId: string,
  modelId: string,
): Promise<void> {
  const staleBuilds = await db.build.findMany({
    where: { modelId },
    select: {
      id: true,
      voxelSha256: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
    },
  });
  const staleUploads = (
    await db.stealthGenerationResult.findMany({
      where: {
        run: { variantId },
        uploadBucket: { not: null },
        uploadPath: { not: null },
      },
      select: { uploadBucket: true, uploadPath: true },
    })
  ).map((upload) => ({ bucket: upload.uploadBucket!, path: upload.uploadPath! }));

  if (staleBuilds.length > 0 && hasSupabaseStorageConfig()) {
    const staleBuildIds = staleBuilds.map((build) => build.id);
    const checksums = staleBuilds
      .map((b) => b.voxelSha256)
      .filter((v): v is string => Boolean(v));
    const storageFilters = staleBuilds
      .filter((b) => b.voxelStorageBucket && b.voxelStoragePath)
      .map((b) => ({
        voxelStorageBucket: b.voxelStorageBucket,
        voxelStoragePath: b.voxelStoragePath,
      }));
    const surviving = await db.build.findMany({
      where: {
        id: { notIn: staleBuildIds },
        OR: [
          ...(checksums.length > 0 ? [{ voxelSha256: { in: checksums } }] : []),
          ...storageFilters,
        ],
      },
      select: { voxelSha256: true, voxelStorageBucket: true, voxelStoragePath: true },
    });
    const survivingChecksums = new Set(
      surviving.map((s) => s.voxelSha256).filter((v): v is string => Boolean(v)),
    );
    const survivingStorageRefs = new Set(
      surviving
        .filter((s) => s.voxelStorageBucket && s.voxelStoragePath)
        .map((s) => `${s.voxelStorageBucket}:${s.voxelStoragePath}`),
    );
    await deleteArenaBuildArtifacts({
      retiringBuilds: staleBuilds,
      survivingChecksums,
      deleteStorage: deleteSupabaseStorageObjects,
    });
    const storageRefs = staleBuilds
      .filter((b) => b.voxelStorageBucket && b.voxelStoragePath)
      .filter((b) => !survivingStorageRefs.has(`${b.voxelStorageBucket}:${b.voxelStoragePath}`))
      .map((b) => ({ bucket: b.voxelStorageBucket!, path: b.voxelStoragePath! }));
    if (storageRefs.length > 0) {
      await deleteSupabaseStorageObjects(storageRefs);
    }
  }
  if (staleUploads.length > 0 && hasSupabaseStorageConfig()) {
    await deleteSupabaseStorageObjects(staleUploads);
  }

  await db.stealthGenerationResult.deleteMany({
    where: { run: { variantId } },
  });
  await db.stealthGenerationRun.deleteMany({
    where: { variantId },
  });
  await db.build.deleteMany({
    where: { modelId },
  });
}

async function isOutdatedReadyCheckpoint(
  db: Prisma.TransactionClient,
  variant: Pick<LockedVariant, "id" | "status">,
): Promise<boolean> {
  if (variant.status !== "READY") return false;
  const run = await db.stealthGenerationRun.findFirst({
    where: { variantId: variant.id, status: "SUCCEEDED" },
    orderBy: { completedAt: "desc" },
    select: { promptCohortId: true },
  });
  return run?.promptCohortId !== BENCHMARK_PROMPT_COHORT_ID;
}

async function isOutdatedUploadCheckpoint(
  db: Prisma.TransactionClient,
  variant: Pick<LockedVariant, "id" | "status">,
): Promise<boolean> {
  if (variant.status !== "READY" && !CONFIGURABLE_VARIANT_STATUSES.includes(variant.status)) {
    return false;
  }
  const run = await db.stealthGenerationRun.findFirst({
    where: { variantId: variant.id },
    orderBy: { startedAt: "desc" },
    select: { promptCohortId: true },
  });
  return run?.promptCohortId !== BENCHMARK_PROMPT_COHORT_ID;
}

export async function syncExperimentReadiness(
  db: Prisma.TransactionClient,
  experimentId: string,
): Promise<void> {
  const variants = await db.stealthVariant.findMany({
    where: { experimentId, status: { not: "WITHDRAWN" } },
    select: { status: true, generatedBuildCount: true, expectedBuildCount: true },
  });
  if (variants.length === 0) {
    await db.stealthExperiment.updateMany({
      where: { id: experimentId, status: { in: [...CONFIGURABLE_EXPERIMENT_STATUSES] } },
      data: { status: "DRAFT" },
    });
    return;
  }
  const allReady = variants.every(
    (variant) =>
      variant.status === "READY" &&
      variant.expectedBuildCount > 0 &&
      variant.generatedBuildCount === variant.expectedBuildCount,
  );
  const generating = variants.some((variant) => variant.status === "GENERATING");
  await db.stealthExperiment.updateMany({
    where: { id: experimentId, status: { in: [...CONFIGURABLE_EXPERIMENT_STATUSES] } },
    data: { status: allReady ? "READY" : generating ? "GENERATING" : "DRAFT" },
  });
}

async function findOrInviteSupabaseAuthUserByEmail(email: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(sanitizeOperationalError(error));
    const found = data.users.find((user) => user.email?.trim().toLowerCase() === email);
    if (found) return found.id;
    if (!data.nextPage) break;
    page = data.nextPage;
  }

  const siteUrl = (
    process.env.MINEBENCH_SITE_URL?.trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://alpha.minebench.ai"
  ).replace(/\/+$/, "");
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${siteUrl}/lab/auth/confirm?next=/lab`,
  });
  if (error) throw new Error(sanitizeOperationalError(error));
  return data.user?.id ?? null;
}

async function findOrInviteOrganizationUserByEmail(
  email: string,
): Promise<{ id: string } | null> {
  let user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) return user;

  const authUserId = await findOrInviteSupabaseAuthUserByEmail(email);
  if (!authUserId) return null;
  user = await prisma.user.upsert({
    where: { id: authUserId },
    create: { id: authUserId, email },
    update: { email },
    select: { id: true },
  });
  return user;
}

export async function acceptExactEmailInvitations(user: {
  id: string;
  email: string;
}): Promise<void> {
  const email = normalizeEmail(user.email);
  const pending = await prisma.organizationInvitation.findMany({
    where: { email, acceptedAt: null, revokedAt: null },
    orderBy: [{ organizationId: "asc" }, { id: "asc" }],
    select: { id: true, organizationId: true },
  });
  if (pending.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const candidate of pending) {
      await lockOrganization(tx, candidate.organizationId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM "OrganizationInvitation"
        WHERE id = ${candidate.id}
          AND email = ${email}
          AND "acceptedAt" IS NULL
          AND "revokedAt" IS NULL
        FOR UPDATE
      `);
      if (locked.length === 0) continue;
      const invitation = await tx.organizationInvitation.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { id: true, organizationId: true, role: true },
      });
      const existingMembership = await tx.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: user.id,
          },
        },
        select: { role: true },
      });
      if (existingMembership) {
        await tx.organizationInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        continue;
      }

      await tx.organizationMembership.create({
        data: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
        },
      });
      const accepted = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: {
          authUserId: user.id,
          acceptedById: user.id,
          acceptedAt: new Date(),
        },
      });
      if (accepted.count !== 1) throw new Error("Invitation is no longer available");
    }
  });
}

export async function provisionStealthOrganization(
  actor: StealthActor,
  input: ProvisionStealthOrganizationInput,
): Promise<{ id: string; slug: string }> {
  assertMineBenchAdminActor(actor);
  const name = normalizeName(input.name, "Name", 140);
  const slug = normalizeStealthSlug(input.slug);
  if (!slug) throw new Error("Slug is required");
  const email = normalizeEmail(input.initialAdminEmail);
  const existing = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existing) throw new Error("Organization slug is already in use");
  const user = await findOrInviteOrganizationUserByEmail(email);

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name, slug },
      select: { id: true, slug: true },
    });
    await tx.organizationInvitation.create({
      data: {
        organizationId: organization.id,
        email,
        role: "ADMIN",
        authUserId: user?.id,
      },
    });
    return organization;
  });
}

export async function listStealthOrganizationsForAdmin(
  actor: StealthActor,
): Promise<StealthOrganizationAdminListItem[]> {
  assertMineBenchAdminActor(actor);
  const organizations = await prisma.organization.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      memberships: {
        where: { role: "ADMIN" },
        orderBy: { user: { email: "asc" } },
        select: { user: { select: { email: true } } },
      },
      _count: { select: { memberships: true, experiments: true } },
    },
  });
  return organizations.map((organization) => ({
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    memberCount: organization._count.memberships,
    adminEmails: organization.memberships.map((membership) => membership.user.email),
    evaluationCount: organization._count.experiments,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  }));
}

export async function getStealthOrganizationForAdmin(
  actor: StealthActor,
  organizationId: string,
): Promise<StealthOrganizationAdminDetail | null> {
  assertMineBenchAdminActor(actor);
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      memberships: {
        orderBy: { user: { email: "asc" } },
        select: {
          role: true,
          user: { select: { email: true, displayName: true } },
        },
      },
      invitations: {
        where: { acceptedAt: null, revokedAt: null },
        orderBy: { email: "asc" },
        select: { email: true, role: true, createdAt: true },
      },
      _count: { select: { memberships: true, experiments: true } },
    },
  });
  if (!organization) return null;
  return {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    memberCount: organization._count.memberships,
    adminEmails: organization.memberships
      .filter((membership) => membership.role === "ADMIN")
      .map((membership) => membership.user.email),
    evaluationCount: organization._count.experiments,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
    memberships: organization.memberships.map((membership) => ({
      email: membership.user.email,
      displayName: membership.user.displayName,
      role: membership.role,
    })),
    pendingInvitations: organization.invitations,
  };
}

export async function inviteOrganizationMember(
  actor: StealthActor,
  organizationId: string,
  params: { email: string; role: OrganizationRole },
): Promise<void> {
  const email = normalizeEmail(params.email);
  const role = normalizeRole(params.role);
  await assertOrganizationAdmin(prisma, actor, organizationId);
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (
    existingUser &&
    (await prisma.organizationMembership.count({
      where: { organizationId, userId: existingUser.id },
    })) > 0
  ) {
    throw new Error("User is already a member");
  }
  const user = existingUser ?? (await findOrInviteOrganizationUserByEmail(email));
  await prisma.$transaction(async (tx) => {
    await lockOrganizationMembershipChange(tx, actor, organizationId);
    if (user) {
      const existingMembership = await tx.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId: user.id } },
        select: { role: true },
      });
      if (existingMembership) throw new Error("User is already a member");
    }
    await tx.organizationInvitation.upsert({
      where: { organizationId_email: { organizationId, email } },
      create: {
        organizationId,
        email,
        role,
        authUserId: user?.id,
      },
      update: {
        role,
        authUserId: user?.id,
        revokedAt: null,
        acceptedAt: null,
        acceptedById: null,
      },
    });
  });
}

export async function updateOrganizationMember(
  actor: StealthActor,
  organizationId: string,
  params: { email: string; role: OrganizationRole },
): Promise<void> {
  const email = normalizeEmail(params.email);
  const role = normalizeRole(params.role);
  await prisma.$transaction(async (tx) => {
    await lockOrganizationMembershipChange(tx, actor, organizationId);
    const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (user && role !== "ADMIN") {
      await assertNotLastAdmin(tx, organizationId, user.id);
    }
    const invitations = await tx.organizationInvitation.updateMany({
      where: { organizationId, email, acceptedAt: null, revokedAt: null },
      data: { role },
    });
    if (user) {
      const updated = await tx.organizationMembership.updateMany({
        where: { organizationId, userId: user.id },
        data: { role },
      });
      if (updated.count === 0 && invitations.count === 0) throw new Error("Member not found");
    } else if (invitations.count === 0) {
      throw new Error("Member not found");
    }
  });
}

export async function removeOrganizationMember(
  actor: StealthActor,
  organizationId: string,
  params: { email: string },
): Promise<void> {
  const email = normalizeEmail(params.email);
  let authUserIdToDelete: string | null = null;

  await prisma.$transaction(async (tx) => {
    await lockOrganizationMembershipChange(tx, actor, organizationId);
    const user = await tx.user.findUnique({
      where: { email },
      select: { id: true, isMineBenchAdmin: true },
    });
    if (user) await assertNotLastAdmin(tx, organizationId, user.id);
    await tx.organizationMembership.deleteMany({
      where: {
        organizationId,
        user: { email },
      },
    });
    await tx.organizationInvitation.updateMany({
      where: { organizationId, email, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (user && !user.isMineBenchAdmin) {
      const remainingMemberships = await tx.organizationMembership.count({
        where: { userId: user.id },
      });
      const remainingActiveInvites = await tx.organizationInvitation.count({
        where: { email, revokedAt: null, acceptedAt: null },
      });
      if (remainingMemberships === 0 && remainingActiveInvites === 0) {
        await tx.organizationInvitation.deleteMany({
          where: { email },
        });
        await tx.user.delete({
          where: { id: user.id },
        });
        authUserIdToDelete = user.id;
      }
    }
  });

  if (authUserIdToDelete) {
    try {
      const supabase = createSupabaseAdminClient();
      await supabase.auth.admin.deleteUser(authUserIdToDelete);
    } catch {
      // Best-effort auth cleanup
    }
  }
}

export async function createStealthEvaluation(
  actor: StealthActor,
  organizationId: string,
  input: CreateStealthEvaluationInput,
): Promise<{ id: string; slug: string }> {
  const access = await assertEvaluationOperator(prisma, actor, organizationId);
  if (
    !access.minebenchAdmin &&
    (input.exportPolicy !== undefined ||
      input.retentionDays !== undefined ||
      input.agreementReference !== undefined)
  ) {
    throw new Error("MineBench admin access is required for agreement settings");
  }
  const name = normalizeName(input.name, "Name", 140);
  const slug = normalizeStealthSlug(input.slug || name);
  if (!slug) throw new Error("Slug is required");
  const targetDecisiveVotes = normalizePositiveInt(
    input.targetDecisiveVotes,
    "Decisive vote goal",
    1_000_000,
  );
  const retentionDays = normalizeRetentionDays(input.retentionDays);
  return prisma.stealthExperiment.create({
    data: {
      organizationId,
      slug,
      name,
      targetDecisiveVotes,
      pauseAtGoal: targetDecisiveVotes ? input.pauseAtGoal ?? true : true,
      exportPolicy: normalizeExportPolicy(input.exportPolicy),
      retentionDays,
      agreementReference: safeText(input.agreementReference, 200),
    },
    select: { id: true, slug: true },
  });
}

export async function updateStealthEvaluation(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  input: UpdateStealthEvaluationInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const access = await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status === "CLOSED") throw new Error("Closed evaluations are read-only");
    if (experiment.endedAt) throw new Error("Evaluation is closing");
    if (
      experiment.status !== "DRAFT" &&
      (input.name !== undefined || input.slug !== undefined)
    ) {
      throw new Error("Evaluation identity is frozen outside draft");
    }
    if (
      !access.minebenchAdmin &&
      (input.exportPolicy !== undefined ||
        input.retentionDays !== undefined ||
        input.agreementReference !== undefined)
    ) {
      throw new Error("MineBench admin access is required for agreement settings");
    }

    const data: Prisma.StealthExperimentUpdateInput = {};
    if (input.name !== undefined) data.name = normalizeName(input.name, "Name", 140);
    if (input.slug !== undefined) {
      const slug = normalizeStealthSlug(input.slug);
      if (!slug) throw new Error("Slug is required");
      data.slug = slug;
    }
    if (input.targetDecisiveVotes !== undefined) {
      data.targetDecisiveVotes = normalizePositiveInt(
        input.targetDecisiveVotes,
        "Decisive vote goal",
        1_000_000,
      );
    }
    if (input.pauseAtGoal !== undefined) data.pauseAtGoal = input.pauseAtGoal;
    if (input.exportPolicy !== undefined) data.exportPolicy = normalizeExportPolicy(input.exportPolicy);
    if (input.retentionDays !== undefined) data.retentionDays = normalizeRetentionDays(input.retentionDays);
    if (input.agreementReference !== undefined) {
      data.agreementReference = safeText(input.agreementReference, 200);
    }

    if (Object.keys(data).length > 0) {
      await tx.stealthExperiment.update({ where: { id: experiment.id }, data });
    }
  });
  await reconcileStealthGoalPause(experimentId);
}

export async function listStealthEvaluationWorkspaces(
  actor: StealthActor,
  organizationId: string,
): Promise<StealthEvaluationWorkspaceListItem[]> {
  await assertEvaluationOperator(prisma, actor, organizationId);
  const evaluations = await prisma.stealthExperiment.findMany({
    where: {
      organizationId,
      ...("organizationUser" in actor ? readableStealthEvaluationWhere() : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      variants: {
        select: {
          status: true,
          expectedBuildCount: true,
          generatedBuildCount: true,
          winCount: true,
          lossCount: true,
          drawCount: true,
          bothBadCount: true,
        },
      },
    },
  });
  return evaluations.map((evaluation) => {
    const buildProgress = evaluation.variants.reduce(
      (total, variant) => ({
        completed: total.completed + variant.generatedBuildCount,
        expected: total.expected + variant.expectedBuildCount,
      }),
      { completed: 0, expected: 0 },
    );
    const decisiveVotes = evaluation.variants.reduce(
      (total, variant) => total + variant.winCount + variant.lossCount,
      0,
    );
    return {
      id: evaluation.id,
      slug: evaluation.slug,
      name: evaluation.name,
      status: evaluation.status,
      checkpointCount:
        evaluation.status === "CLOSED"
          ? evaluation.variants.length
          : evaluation.variants.filter((variant) => variant.status !== "WITHDRAWN").length,
      buildProgress,
      voteProgress: { decisiveVotes, targetDecisiveVotes: evaluation.targetDecisiveVotes },
      updatedAt: evaluation.updatedAt,
    };
  });
}

export async function getStealthEvaluationWorkspace(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
): Promise<StealthEvaluationWorkspace | null> {
  await assertEvaluationOperator(prisma, actor, organizationId);
  await prisma.$transaction(async (tx) => {
    const experiment = await lockExperiment(tx, experimentId);
    if (
      !experiment ||
      experiment.organizationId !== organizationId ||
      !isStealthCheckpointSetOpen(experiment.status)
    ) {
      return;
    }
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    let reclaimed = 0;
    for (const variant of variants) {
      await lockVariant(tx, variant.id);
      reclaimed += await reclaimStaleStealthGenerationRuns(tx, variant.id);
    }
    if (reclaimed > 0) await syncExperimentReadiness(tx, experimentId);
  });
  const evaluation = await prisma.stealthExperiment.findFirst({
    where: { id: experimentId, organizationId, ...readableStealthEvaluationWhere() },
    include: {
      organization: { select: { id: true, slug: true, name: true } },
      variants: {
        orderBy: { codename: "asc" },
        include: {
          credential: { select: { id: true } },
          model: {
            select: {
              _count: { select: { builds: true } },
              builds: {
                where: { prompt: { text: { in: Object.values(BENCHMARK_PROMPT_MAP) } } },
                select: { id: true },
              },
            },
          },
          generationRuns: {
            orderBy: { startedAt: "desc" },
            take: 1,
            include: {
              results: {
                orderBy: { prompt: { text: "asc" } },
                include: {
                  prompt: { select: { id: true, text: true } },
                  build: {
                    select: {
                      blockCount: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!evaluation) return null;
  return {
    id: evaluation.id,
    slug: evaluation.slug,
    name: evaluation.name,
    status: evaluation.status,
    exportPolicy: evaluation.exportPolicy,
    targetDecisiveVotes: evaluation.targetDecisiveVotes,
    pauseAtGoal: evaluation.pauseAtGoal,
    retentionDays: evaluation.retentionDays,
    agreementReference: evaluation.agreementReference,
    startsAt: evaluation.startsAt,
    checkpointSetFrozenAt: evaluation.checkpointSetFrozenAt,
    endedAt: evaluation.endedAt,
    retentionDeleteAt: evaluation.retentionDeleteAt,
    organization: evaluation.organization,
    checkpoints: evaluation.variants.map((variant) => {
      const latestRun = variant.generationRuns[0] ?? null;
      return {
        id: variant.id,
        codename: variant.codename,
        source: variant.source,
        status: variant.status,
        endpointEnabled: variant.endpointEnabled,
        credentialConfigured: Boolean(variant.credential),
        expectedBuildCount: variant.expectedBuildCount,
        generatedBuildCount: variant.generatedBuildCount,
        persistedBuildCount: variant.model._count.builds,
        promptCohortCurrent: latestRun?.promptCohortId === BENCHMARK_PROMPT_COHORT_ID,
        currentExpectedBuildCount: Object.keys(BENCHMARK_PROMPT_MAP).length,
        currentGeneratedBuildCount: variant.model.builds.length,
        generationFailureCount: variant.generationFailureCount,
        lastGenerationError: variant.lastGenerationError
          ? sanitizeOperationalError(variant.lastGenerationError)
          : null,
        cohortGeneratedAt: variant.cohortGeneratedAt,
        decisiveVotes: variant.winCount + variant.lossCount,
        totalVotes: variant.winCount + variant.lossCount + variant.drawCount + variant.bothBadCount,
        latestGenerationRun: latestRun
          ? {
              id: latestRun.id,
              status: latestRun.status,
              promptCohortId: latestRun.promptCohortId,
              workflowRunId: latestRun.workflowRunId,
              completedBuildCount: latestRun.completedBuildCount,
              expectedBuildCount: latestRun.expectedBuildCount,
              failedBuildCount: latestRun.failedBuildCount,
              providerCallCount: latestRun.providerCallCount,
              retryCount: latestRun.retryCount,
              startedAt: latestRun.startedAt,
              completedAt: latestRun.completedAt,
              error: latestRun.error ? sanitizeOperationalError(latestRun.error) : null,
              results: latestRun.results.map((result) => ({
                resultId: result.id,
                promptId: result.prompt.id,
                prompt: result.prompt.text,
                status: result.status,
                attempts: result.attempts,
                generationTimeMs: result.generationTimeMs,
                requestConfiguration: result.requestConfiguration,
                error: result.error ? sanitizeOperationalError(result.error) : null,
                uploadPending: Boolean(result.uploadQueuedAt),
                build: result.build
                  ? {
                      blockCount: result.build.blockCount,
                    }
                  : null,
              })),
            }
          : null,
      };
    }),
  };
}

export async function configureStealthEndpoint(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  input: ConfigureStealthEndpointInput,
): Promise<{ variantId: string }> {
  const codename = normalizeName(input.codename, "Codename", 80);
  const encrypted = encryptStealthEndpointConfig(input.config);
  const fingerprint = checkpointFingerprint(input.config.endpointUrl, input.config.modelId);

  return prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (!isStealthCheckpointSetOpen(experiment.status)) {
      throw new Error("Activated evaluations cannot accept new checkpoints");
    }

    const existing = input.variantId
      ? await lockVariant(tx, input.variantId)
      : await lockVariantByCodename(tx, experiment.id, codename);
    if (existing) {
      if (existing.experimentId !== experiment.id) throw new Error("Checkpoint not found");
      const refreshingOutdatedCheckpoint =
        existing.source === "ENDPOINT" && (await isOutdatedReadyCheckpoint(tx, existing));
      if (
        !CONFIGURABLE_VARIANT_STATUSES.includes(existing.status) &&
        !refreshingOutdatedCheckpoint
      ) {
        throw new Error("This checkpoint cannot be changed");
      }
      if (refreshingOutdatedCheckpoint) {
        await assertCheckpointRetryable(tx, existing.id);
      } else if (existing.status === "DRAFT") {
        await assertCheckpointRetryable(tx, existing.id);
        await purgeDraftCheckpointBuilds(tx, existing.id, existing.modelId);
      } else {
        await assertNoCheckpointData(tx, existing.id, existing.modelId);
      }
      await tx.stealthVariant.update({
        where: { id: existing.id },
        data: {
          codename,
          source: "ENDPOINT",
          ...(refreshingOutdatedCheckpoint ? { status: "DRAFT" as const } : {}),
          checkpointFingerprint: fingerprint,
          endpointEnabled: true,
          expectedBuildCount: Object.keys(BENCHMARK_PROMPT_MAP).length,
          generatedBuildCount: 0,
          generationFailureCount: 0,
          cohortGeneratedAt: null,
          lastGenerationError: null,
        },
      });
      await tx.model.update({
        where: { id: existing.modelId },
        data: { displayName: codename, enabled: false },
      });
      await tx.stealthEndpointCredential.upsert({
        where: { variantId: existing.id },
        create: { variantId: existing.id, ...encrypted },
        update: encrypted,
      });
      await syncExperimentReadiness(tx, experiment.id);
      return { variantId: existing.id };
    }

    const variantId = randomUUID();
    const modelId = randomUUID();
    await tx.model.create({
      data: {
        id: modelId,
        key: opaqueStealthModelKey(experiment.id, variantId),
        provider: "Stealth",
        modelId: variantId,
        displayName: codename,
        enabled: false,
      },
    });
    await tx.stealthVariant.create({
      data: {
        id: variantId,
        experimentId: experiment.id,
        codename,
        source: "ENDPOINT",
        modelId,
        checkpointFingerprint: fingerprint,
        endpointEnabled: true,
        expectedBuildCount: Object.keys(BENCHMARK_PROMPT_MAP).length,
        credential: { create: encrypted },
      },
    });
    await syncExperimentReadiness(tx, experiment.id);
    return { variantId };
  });
}

export async function createStealthUploadCheckpoint(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  input: CreateStealthUploadCheckpointInput,
): Promise<{ variantId: string; runId: string }> {
  const codename = normalizeName(input.codename, "Codename", 80);
  const prompts = await prepareStealthCohortPrompts();
  return prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (!isStealthCheckpointSetOpen(experiment.status)) {
      throw new Error("Activated evaluations cannot accept new checkpoints");
    }
    const existing = input.variantId
      ? await lockVariant(tx, input.variantId)
      : await lockVariantByCodename(tx, experiment.id, codename);
    if (existing) {
      if (existing.experimentId !== experiment.id || existing.source !== "UPLOAD") {
        throw new Error("Checkpoint not found");
      }
      if (!input.variantId) throw new Error("Checkpoint codename already exists");
      if (!(await isOutdatedUploadCheckpoint(tx, existing))) {
        throw new Error("Only outdated upload checkpoints can be refreshed");
      }
      await assertCheckpointUnvoted(tx, existing.id);
      await purgeDraftCheckpointBuilds(tx, existing.id, existing.modelId);
      await tx.stealthVariant.update({
        where: { id: existing.id },
        data: {
          status: "DRAFT",
          expectedBuildCount: prompts.length,
          generatedBuildCount: 0,
          generationFailureCount: 0,
          cohortGeneratedAt: null,
          lastGenerationError: null,
        },
      });
      const runId = await createStealthUploadRun(
        tx,
        existing.id,
        prompts.map((prompt) => prompt.prompt.id),
      );
      await syncExperimentReadiness(tx, experiment.id);
      return { variantId: existing.id, runId };
    }
    if (input.variantId) throw new Error("Checkpoint not found");

    const variantId = randomUUID();
    const modelId = randomUUID();
    await tx.model.create({
      data: {
        id: modelId,
        key: opaqueStealthModelKey(experiment.id, variantId),
        provider: "Stealth",
        modelId: variantId,
        displayName: codename,
        enabled: false,
      },
    });
    await tx.stealthVariant.create({
      data: {
        id: variantId,
        experimentId: experiment.id,
        codename,
        source: "UPLOAD",
        status: "DRAFT",
        modelId,
        endpointEnabled: false,
        expectedBuildCount: prompts.length,
      },
    });
    const runId = await createStealthUploadRun(
      tx,
      variantId,
      prompts.map((prompt) => prompt.prompt.id),
    );
    await syncExperimentReadiness(tx, experiment.id);
    return { variantId, runId };
  });
}

function resumableUploadEndpoint(): string {
  const endpoint = new URL(getSupabaseStorageConfig().url);
  if (endpoint.hostname.endsWith(".supabase.co")) {
    endpoint.hostname = endpoint.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
  }
  endpoint.pathname = "/storage/v1/upload/resumable";
  endpoint.search = "";
  return endpoint.toString();
}

export async function createStealthBuildUploadTarget(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  resultId: string,
): Promise<StealthBuildUploadTarget> {
  const now = new Date();
  const bucket = getBuildStorageBucketFromEnv();
  const prepared = await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (!isStealthCheckpointSetOpen(experiment.status)) {
      throw new Error("Evaluation uploads are closed");
    }
    const identity = await tx.stealthGenerationResult.findUnique({
      where: { id: resultId },
      select: { run: { select: { variantId: true } } },
    });
    if (!identity) throw new Error("Build slot not found");
    const variant = await lockVariant(tx, identity.run.variantId);
    if (
      !variant ||
      variant.experimentId !== experiment.id ||
      variant.source !== "UPLOAD" ||
      !CONFIGURABLE_VARIANT_STATUSES.includes(variant.status)
    ) {
      throw new Error("Build slot not found");
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "StealthGenerationResult" WHERE id = ${resultId} FOR UPDATE
    `);
    const result = await tx.stealthGenerationResult.findUnique({
      where: { id: resultId },
      include: { run: { select: { status: true, promptCohortId: true } } },
    });
    if (!result || result.run.status !== "RUNNING") throw new Error("Build slot is closed");
    if (result.run.promptCohortId !== BENCHMARK_PROMPT_COHORT_ID) {
      throw new Error("The prompt cohort has changed");
    }
    if (result.status === "READY") throw new Error("Build is already ready");
    if (result.status === "GENERATING" || result.status === "VALIDATING") {
      throw new Error("Build is already processing");
    }
    if (result.status === "QUEUED" && result.uploadQueuedAt) {
      throw new Error("Build is already queued");
    }

    const reusable =
      result.status === "QUEUED" &&
      result.uploadPath &&
      result.uploadBucket === bucket &&
      result.uploadExpiresAt &&
      result.uploadExpiresAt > now;
    const path = reusable
      ? result.uploadPath!
      : `${BUILD_UPLOAD_PREFIX}/${organizationId}/${experimentId}/${variant.id}/${result.promptId}/${randomUUID()}.json`;
    const previous =
      !reusable && result.uploadBucket && result.uploadPath
        ? { bucket: result.uploadBucket, path: result.uploadPath }
        : null;
    if (!reusable) {
      await tx.stealthGenerationResult.update({
        where: { id: result.id },
        data: {
          status: "QUEUED",
          error: null,
          workerAttempts: 0,
          runAfter: now,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          uploadBucket: bucket,
          uploadPath: path,
          uploadExpiresAt: new Date(now.getTime() + BUILD_UPLOAD_TTL_MS),
          uploadQueuedAt: null,
        },
      });
    }
    return { path, previous };
  });

  const token = await createSupabaseSignedUploadToken({ bucket, path: prepared.path });
  if (prepared.previous) {
    await deleteSupabaseStorageObjects([prepared.previous]).catch(() => undefined);
  }
  return {
    resultId,
    bucket,
    path: prepared.path,
    endpoint: resumableUploadEndpoint(),
    token,
  };
}

export async function queueStealthBuildUpload(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  resultId: string,
): Promise<void> {
  const upload = await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    const result = await tx.stealthGenerationResult.findFirst({
      where: {
        id: resultId,
        run: { variant: { experimentId, source: "UPLOAD" } },
      },
      select: {
        uploadBucket: true,
        uploadPath: true,
        uploadExpiresAt: true,
        uploadQueuedAt: true,
      },
    });
    if (
      !result?.uploadBucket ||
      !result.uploadPath ||
      !result.uploadExpiresAt ||
      result.uploadExpiresAt <= new Date()
    ) {
      throw new Error("Upload expired; choose the file again");
    }
    if (result.uploadQueuedAt) return null;
    return {
      bucket: result.uploadBucket,
      path: result.uploadPath,
      expiresAt: result.uploadExpiresAt,
    };
  });
  if (!upload) return;

  await assertSupabaseStorageObjectExists(upload);

  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (
      !experiment ||
      experiment.organizationId !== organizationId ||
      !isStealthCheckpointSetOpen(experiment.status)
    ) {
      throw new Error("Evaluation uploads are closed");
    }
    const identity = await tx.stealthGenerationResult.findUnique({
      where: { id: resultId },
      select: { run: { select: { variantId: true } } },
    });
    if (!identity) throw new Error("Build slot not found");
    const variant = await lockVariant(tx, identity.run.variantId);
    if (
      !variant ||
      variant.experimentId !== experiment.id ||
      variant.source !== "UPLOAD" ||
      !CONFIGURABLE_VARIANT_STATUSES.includes(variant.status)
    ) {
      throw new Error("Build slot not found");
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "StealthGenerationResult" WHERE id = ${resultId} FOR UPDATE
    `);
    const queuedAt = new Date();
    const queued = await tx.stealthGenerationResult.updateMany({
      where: {
        id: resultId,
        status: { in: ["QUEUED", "FAILED"] },
        uploadBucket: upload.bucket,
        uploadPath: upload.path,
        uploadExpiresAt: upload.expiresAt,
        uploadQueuedAt: null,
        run: { status: "RUNNING", promptCohortId: BENCHMARK_PROMPT_COHORT_ID },
      },
      data: {
        status: "QUEUED",
        error: null,
        workerAttempts: 0,
        uploadQueuedAt: queuedAt,
      },
    });
    if (queued.count !== 1) throw new Error("Build slot changed; refresh and try again");
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: { status: "GENERATING", lastGenerationError: null },
    });
    await syncExperimentReadiness(tx, experiment.id);
  });
}

export async function activateStealthEvaluation(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status !== "READY") throw new Error("Evaluation is not ready");
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id, status: { not: "WITHDRAWN" } },
      select: {
        id: true,
        codename: true,
        status: true,
        modelId: true,
        expectedBuildCount: true,
        generatedBuildCount: true,
        generationRuns: {
          where: { status: "SUCCEEDED" },
          orderBy: { completedAt: "desc" },
          take: 1,
          select: { promptCohortId: true },
        },
      },
    });
    if (variants.length === 0) throw new Error("Add a checkpoint first");
    for (const variant of variants) {
      if (variant.status !== "READY") throw new Error(`${variant.codename} is not ready`);
      if (variant.expectedBuildCount === 0 || variant.generatedBuildCount !== variant.expectedBuildCount) {
        throw new Error(`${variant.codename} is incomplete`);
      }
      if (variant.generationRuns[0]?.promptCohortId !== BENCHMARK_PROMPT_COHORT_ID) {
        throw new Error(`${variant.codename} uses an outdated prompt cohort`);
      }
    }
    const now = new Date();
    await tx.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: true },
    });
    await tx.stealthVariant.updateMany({
      where: { id: { in: variants.map((variant) => variant.id) } },
      data: { status: "ACTIVE", endpointEnabled: false },
    });
    await tx.stealthEndpointCredential.deleteMany({
      where: { variantId: { in: variants.map((variant) => variant.id) } },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: {
        status: "ACTIVE",
        startsAt: experiment.startsAt ?? now,
        checkpointSetFrozenAt: experiment.checkpointSetFrozenAt ?? now,
        endedAt: null,
      },
    });
  });
  invalidateStealthSamplingCache();
}

export async function pauseStealthEvaluation(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status !== "ACTIVE") throw new Error("Evaluation is not active");
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id, status: "ACTIVE" },
      select: { modelId: true },
    });
    await tx.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: false },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "PAUSED" },
    });
  });
  invalidateStealthSamplingCache();
}

export async function resumeStealthEvaluation(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status !== "PAUSED") throw new Error("Evaluation is not paused");
    if (experiment.endedAt) throw new Error("Evaluation is closing");
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id, status: "ACTIVE" },
      select: { modelId: true, winCount: true, lossCount: true },
    });
    if (variants.length === 0) throw new Error("Evaluation has no active checkpoints");
    if (
      experiment.pauseAtGoal &&
      experiment.targetDecisiveVotes != null &&
      variants.every(
        (variant) =>
          variant.winCount + variant.lossCount >= experiment.targetDecisiveVotes!,
      )
    ) {
      throw new Error("Increase or remove the vote goal before resuming");
    }
    await tx.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: true },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "ACTIVE" },
    });
  });
  invalidateStealthSamplingCache();
}

export async function closeStealthEvaluation(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  params?: { retentionDays?: number },
): Promise<void> {
  const closeState = await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status === "CLOSED") return null;
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    const retentionDays =
      params?.retentionDays === undefined
        ? experiment.retentionDays
        : normalizeRetentionDays(params.retentionDays);
    const endedAt = experiment.endedAt ?? new Date();
    await tx.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: false },
    });
    await tx.stealthVariant.updateMany({
      where: { id: { in: variants.map((variant) => variant.id) } },
      data: { endpointEnabled: false },
    });
    await tx.stealthEndpointCredential.deleteMany({
      where: { variantId: { in: variants.map((variant) => variant.id) } },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "PAUSED", endedAt, retentionDays },
    });
    return { retentionDays, endedAt };
  });
  if (!closeState) return;
  invalidateStealthSamplingCache();
  const { drainStealthVoteJobsForExperiment } = await import("@/lib/arena/voteJobs");
  await drainStealthVoteJobsForExperiment(experimentId);
  const { terminalizeStealthGenerationRunsForClosure } = await import(
    "@/lib/stealth/generationRun"
  );
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status === "CLOSED") return;
    const pendingVoteJobs = await tx.arenaVoteJob.count({
      where: { processedAt: null, stealthVariant: { experimentId: experiment.id } },
    });
    if (pendingVoteJobs > 0) throw new Error("Votes are still settling; try again");
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    await tx.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: false },
    });
    await tx.stealthVariant.updateMany({
      where: { experimentId: experiment.id },
      data: { status: "WITHDRAWN", endpointEnabled: false },
    });
    await tx.stealthEndpointCredential.deleteMany({
      where: { variantId: { in: variants.map((variant) => variant.id) } },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: {
        status: "CLOSED",
        endedAt: closeState.endedAt,
        retentionDays: closeState.retentionDays,
        retentionDeleteAt: new Date(
          closeState.endedAt.getTime() + closeState.retentionDays * 86_400_000,
        ),
      },
    });
    await terminalizeStealthGenerationRunsForClosure(tx, experiment.id);
  });
  invalidateStealthSamplingCache();
}

async function createStealthUploadRun(
  tx: Prisma.TransactionClient,
  variantId: string,
  promptIds: string[],
): Promise<string> {
  const run = await tx.stealthGenerationRun.create({
    data: {
      variantId,
      status: "RUNNING",
      promptCohortId: BENCHMARK_PROMPT_COHORT_ID,
      expectedBuildCount: promptIds.length,
      configuration: {
        source: "upload",
        gridSize: GRID_SIZE,
        palette: PALETTE,
        mode: MODE,
      } satisfies Prisma.InputJsonObject,
      results: {
        createMany: {
          data: promptIds.map((promptId) => ({ promptId, status: "QUEUED" })),
        },
      },
    },
    select: { id: true },
  });
  return run.id;
}

export async function disableStealthEndpoint(
  actor: StealthActor,
  organizationId: string,
  variantId: string,
): Promise<void> {
  const runIds = await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const identity = await tx.stealthVariant.findUnique({
      where: { id: variantId },
      select: { experimentId: true },
    });
    if (!identity) throw new Error("Checkpoint not found");
    const experiment = await lockExperiment(tx, identity.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Checkpoint not found");
    }
    const variant = await lockVariant(tx, variantId);
    if (!variant || variant.experimentId !== experiment.id) {
      throw new Error("Checkpoint not found");
    }
    if (experiment.status === "CLOSED") throw new Error("Closed evaluations are read-only");
    if (variant.source !== "ENDPOINT") throw new Error("Checkpoint does not use an endpoint");
    const [buildCount, activeRuns] = await Promise.all([
      tx.build.count({ where: { modelId: variant.modelId } }),
      tx.stealthGenerationRun.findMany({
        where: { variantId: variant.id, status: "RUNNING" },
        select: { id: true },
      }),
    ]);
    const withdrawPartial = buildCount > 0 && variant.status !== "READY";
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: {
        endpointEnabled: false,
        ...(withdrawPartial
          ? { status: "WITHDRAWN" as const }
          : buildCount === 0 && variant.status === "GENERATING"
          ? {
              status: "DRAFT" as const,
              generatedBuildCount: 0,
              generationFailureCount: 0,
              lastGenerationError: null,
            }
          : {}),
      },
    });
    if (withdrawPartial) {
      await tx.model.update({ where: { id: variant.modelId }, data: { enabled: false } });
    }
    await tx.stealthEndpointCredential.deleteMany({ where: { variantId: variant.id } });
    await syncExperimentReadiness(tx, experiment.id);
    return activeRuns.map((run) => run.id);
  });
  const { failStealthGenerationRun } = await import("@/lib/stealth/generationRun");
  for (const runId of runIds) {
    await failStealthGenerationRun(runId, "Endpoint disabled");
  }
}

export async function deleteUnusedDraftEvaluation(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status !== "DRAFT") throw new Error("Only unused drafts can be deleted");
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    const variantIds = variants.map((variant) => variant.id);
    const modelIds = variants.map((variant) => variant.modelId);
    for (const variantId of variantIds) {
      await reclaimStaleStealthGenerationRuns(tx, variantId, now);
    }
    const [acceptedBuildCount, matchupCount, voteCount, activeRunCount] = await Promise.all([
      tx.build.count({
        where: {
          modelId: { in: modelIds },
          stealthGenerationResults: { some: { status: "READY" } },
        },
      }),
      tx.matchup.count({ where: { stealthVariantId: { in: variantIds } } }),
      tx.vote.count({ where: { matchup: { stealthVariantId: { in: variantIds } } } }),
      tx.stealthGenerationRun.count({
        where: {
          variantId: { in: variantIds },
          status: "RUNNING",
          OR: [
            { variant: { source: "ENDPOINT" } },
            {
              results: {
                some: {
                  OR: [
                    { status: { in: ["GENERATING", "VALIDATING"] } },
                    { status: "QUEUED", uploadQueuedAt: { not: null } },
                  ],
                },
              },
            },
          ],
        },
      }),
    ]);
    if (acceptedBuildCount > 0 || matchupCount > 0 || voteCount > 0 || activeRunCount > 0) {
      throw new Error("Only unused drafts can be deleted");
    }
    const uploads = await tx.stealthGenerationResult.findMany({
      where: {
        run: { variant: { experimentId: experiment.id } },
        uploadPath: { not: null },
      },
      select: { uploadExpiresAt: true },
    });
    if (uploads.some((upload) => upload.uploadExpiresAt && upload.uploadExpiresAt > now)) {
      throw new Error("A pending build upload must expire before this draft can be deleted");
    }
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "CLOSED", endedAt: now, retentionDeleteAt: now },
    });
    await tx.stealthVariant.updateMany({
      where: { id: { in: variantIds } },
      data: { status: "WITHDRAWN", endpointEnabled: false },
    });
    await tx.stealthEndpointCredential.deleteMany({
      where: { variantId: { in: variantIds } },
    });
  });
  await purgeStealthEvaluationIfDue(experimentId, now);
}

export async function getProtectedStealthBuild(
  actor: StealthActor,
  organizationId: string,
  resultId: string,
): Promise<{
  resultId: string;
  status: StealthGenerationResultStatus;
  prompt: { id: string; text: string };
  checkpoint: { id: string; codename: string };
  build: { blockCount: number } | null;
} | null> {
  await assertEvaluationOperator(prisma, actor, organizationId);
  const result = await prisma.stealthGenerationResult.findFirst({
    where: {
      id: resultId,
      run: {
        variant: {
          experiment: {
            organizationId,
            ...readableStealthEvaluationWhere(),
          },
        },
      },
    },
    select: {
      id: true,
      status: true,
      prompt: { select: { id: true, text: true } },
      build: { select: { blockCount: true } },
      run: {
        select: {
          variant: { select: { id: true, codename: true } },
        },
      },
    },
  });
  if (!result) return null;
  return {
    resultId: result.id,
    status: result.status,
    prompt: result.prompt,
    checkpoint: result.run.variant,
    build: result.build,
  };
}

export async function recordStealthReleaseMapping(
  actor: StealthActor,
  organizationId: string,
  input: RecordStealthReleaseMappingInput,
): Promise<{ variantId: string; releasedModelId: string; releasedAt: Date }> {
  const publicModelKey = input.publicModelKey.trim();
  if (!publicModelKey) throw new Error("Public model key is required");
  const checkpointCodename = normalizeName(input.checkpointCodename, "Checkpoint codename", 80);

  return prisma.$transaction(async (tx) => {
    await assertOrganizationAdmin(tx, actor, organizationId);
    const identity = await tx.stealthVariant.findUnique({
      where: { id: input.variantId },
      select: { experimentId: true },
    });
    if (!identity) throw new Error("Checkpoint not found");
    const experiment = await lockExperiment(tx, identity.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Checkpoint not found");
    }
    const variant = await lockVariant(tx, input.variantId);
    if (!variant || variant.experimentId !== experiment.id) {
      throw new Error("Checkpoint not found");
    }
    if (experiment.status !== "CLOSED") {
      throw new Error("Release mapping requires a closed evaluation");
    }
    if (variant.codename !== checkpointCodename) {
      throw new Error("Checkpoint attestation does not match");
    }
    const publicModel = await tx.model.findFirst({
      where: { key: publicModelKey, stealthVariant: null },
      select: { id: true },
    });
    if (!publicModel) throw new Error("Public model not found");
    const releasedAt = variant.releasedAt ?? new Date();
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: {
        releasedModelId: publicModel.id,
        releasedAt,
      },
    });
    return {
      variantId: variant.id,
      releasedModelId: publicModel.id,
      releasedAt,
    };
  });
}

export async function reconcileStealthGoalPause(experimentId: string): Promise<boolean> {
  const paused = await prisma.$transaction(async (tx) => {
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment) return false;
    if (
      experiment.status !== "ACTIVE" ||
      !experiment.pauseAtGoal ||
      experiment.targetDecisiveVotes == null
    ) {
      return false;
    }
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id, status: "ACTIVE" },
      select: { modelId: true, winCount: true, lossCount: true },
    });
    if (variants.length === 0) return false;
    const allAtGoal = variants.every(
      (variant) => variant.winCount + variant.lossCount >= experiment.targetDecisiveVotes!,
    );
    if (!allAtGoal) return false;
    await tx.model.updateMany({
      where: { id: { in: variants.map((variant) => variant.modelId) } },
      data: { enabled: false },
    });
    await tx.stealthExperiment.update({
      where: { id: experiment.id },
      data: { status: "PAUSED" },
    });
    return true;
  });
  if (paused) invalidateStealthSamplingCache();
  return paused;
}

export async function reconcileStealthVoteGoals(
  experimentIds: string | string[],
): Promise<boolean> {
  const ids = Array.isArray(experimentIds) ? experimentIds : [experimentIds];
  const results = await Promise.all(ids.map((id) => reconcileStealthGoalPause(id)));
  return results.some(Boolean);
}

export async function reconcileActiveStealthVoteGoals(): Promise<boolean> {
  const evaluations = await prisma.stealthExperiment.findMany({
    where: {
      status: "ACTIVE",
      pauseAtGoal: true,
      targetDecisiveVotes: { not: null },
    },
    select: { id: true },
  });
  return reconcileStealthVoteGoals(evaluations.map((evaluation) => evaluation.id));
}

async function listStealthBuildStorageRefs(
  variantIds: string[],
): Promise<Array<{ bucket: string; path: string }>> {
  if (variantIds.length === 0) return [];
  const bucket = getBuildStorageBucketFromEnv();
  const config = getSupabaseStorageConfig();
  const refs: Array<{ bucket: string; path: string }> = [];
  for (const variantId of variantIds) {
    const prefix = getStealthBuildStoragePrefix(variantId);
    for (let offset = 0; ; offset += 1_000) {
      const response = await fetch(
        `${config.url}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefix, limit: 1_000, offset }),
        },
      );
      if (!response.ok) throw new Error(`Storage listing failed (${response.status})`);
      const objects = (await response.json()) as Array<{ id?: string | null; name?: string }>;
      for (const object of objects) {
        if (!object.id) continue;
        const name = object.name?.replace(/^\/+/, "");
        if (!name) continue;
        refs.push({
          bucket,
          path: name.startsWith(`${prefix}/`) ? name : `${prefix}/${name}`,
        });
      }
      if (objects.length < 1_000) break;
    }
  }
  return refs;
}

export async function purgeDueStealthEvaluations(
  actor: StealthActor,
  params?: { now?: Date; limit?: number },
): Promise<{
  purged: number;
  evaluationIds: string[];
  failures: Array<{ evaluationId: string; error: string }>;
}> {
  if (!isMineBenchAdmin(actor)) throw new Error("MineBench admin access is required");
  const now = params?.now ?? new Date();
  const limit = Math.max(1, Math.min(100, params?.limit ?? 25));
  const purged: string[] = [];
  const failures: Array<{ evaluationId: string; error: string }> = [];
  if (hasSupabaseStorageConfig()) {
    let uploadCursor: { expiresAt: Date; id: string } | null = null;
    while (true) {
      const expiredUploads: Array<{
        id: string;
        experimentId: string;
        bucket: string;
        path: string;
        expiresAt: Date;
      }> = (await prisma.stealthGenerationResult.findMany({
        where: {
          uploadExpiresAt: { lte: now },
          uploadBucket: { not: null },
          uploadPath: { not: null },
          OR: [{ uploadQueuedAt: null }, { status: { in: ["FAILED", "READY"] } }],
          ...(uploadCursor
            ? {
                AND: [
                  {
                    OR: [
                      { uploadExpiresAt: { gt: uploadCursor.expiresAt } },
                      {
                        uploadExpiresAt: uploadCursor.expiresAt,
                        id: { gt: uploadCursor.id },
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ uploadExpiresAt: "asc" }, { id: "asc" }],
        take: 100,
        select: {
          id: true,
          uploadBucket: true,
          uploadPath: true,
          uploadExpiresAt: true,
          run: { select: { variant: { select: { experimentId: true } } } },
        },
      })).map((upload) => ({
        id: upload.id,
        experimentId: upload.run.variant.experimentId,
        bucket: upload.uploadBucket!,
        path: upload.uploadPath!,
        expiresAt: upload.uploadExpiresAt!,
      }));
      if (expiredUploads.length === 0) break;
      for (const upload of expiredUploads) {
        try {
          await deleteSupabaseStorageObjects([upload]);
          await prisma.stealthGenerationResult.updateMany({
            where: { id: upload.id, uploadPath: upload.path, uploadExpiresAt: { lte: now } },
            data: {
              uploadBucket: null,
              uploadPath: null,
              uploadExpiresAt: null,
              uploadQueuedAt: null,
            },
          });
        } catch (error) {
          failures.push({
            evaluationId: upload.experimentId,
            error: sanitizeOperationalError(error),
          });
        }
      }
      const lastUpload: (typeof expiredUploads)[number] = expiredUploads.at(-1)!;
      uploadCursor = { expiresAt: lastUpload.expiresAt, id: lastUpload.id };
    }
  }
  let cursor: { retentionDeleteAt: Date; id: string } | null = null;
  while (purged.length < limit) {
    const due: Array<{ id: string; retentionDeleteAt: Date | null }> =
      await prisma.stealthExperiment.findMany({
        where: {
          status: "CLOSED",
          retentionDeleteAt: { lte: now },
          ...(cursor
            ? {
                OR: [
                  { retentionDeleteAt: { gt: cursor.retentionDeleteAt } },
                  { retentionDeleteAt: cursor.retentionDeleteAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ retentionDeleteAt: "asc" }, { id: "asc" }],
        take: Math.max(1, limit - purged.length),
        select: { id: true, retentionDeleteAt: true },
      });
    if (due.length === 0) break;
    const last: { id: string; retentionDeleteAt: Date | null } = due[due.length - 1]!;
    cursor = { id: last.id, retentionDeleteAt: last.retentionDeleteAt! };
    for (const evaluation of due) {
      try {
        const result = await purgeStealthEvaluationIfDue(evaluation.id, now);
        if (result) purged.push(evaluation.id);
      } catch (error) {
        failures.push({ evaluationId: evaluation.id, error: sanitizeOperationalError(error) });
      }
      if (purged.length >= limit) break;
    }
  }
  return { purged: purged.length, evaluationIds: purged, failures };
}

export async function purgeStealthEvaluationIfDue(
  experimentId: string,
  now = new Date(),
): Promise<boolean> {
  const snapshot = await prisma.$transaction(async (tx) => {
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment) return null;
    if (
      experiment.status !== "CLOSED" ||
      !experiment.retentionDeleteAt ||
      experiment.retentionDeleteAt > now
    ) {
      return null;
    }
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    const builds = await tx.build.findMany({
      where: { modelId: { in: variants.map((variant) => variant.modelId) } },
      select: {
        id: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelSha256: true,
        _count: { select: { arenaArtifacts: true } },
      },
    });
    const buildUploads = (
      await tx.stealthGenerationResult.findMany({
        where: {
          run: { variant: { experimentId: experiment.id } },
          uploadBucket: { not: null },
          uploadPath: { not: null },
        },
        select: { uploadBucket: true, uploadPath: true },
      })
    ).map((upload) => ({ bucket: upload.uploadBucket!, path: upload.uploadPath! }));
    const cohortUploads = await tx.stealthCohortUpload.findMany({
      where: { experimentId: experiment.id },
      select: { bucket: true, path: true },
    });
    const checksums = Array.from(
      new Set(builds.map((build) => build.voxelSha256?.trim()).filter(Boolean) as string[]),
    );
    const surviving = checksums.length > 0
      ? await tx.build.findMany({
          where: {
            id: { notIn: builds.map((build) => build.id) },
            voxelSha256: { in: checksums },
          },
          select: {
            voxelSha256: true,
            voxelStorageBucket: true,
            voxelStoragePath: true,
          },
        })
      : [];
    return {
      experimentId: experiment.id,
      variants,
      builds,
      buildUploads: [...buildUploads, ...cohortUploads],
      survivingChecksums: new Set(
        surviving.flatMap((build) => (build.voxelSha256 ? [build.voxelSha256] : [])),
      ),
      survivingStorageRefs: new Set(
        surviving.flatMap((build) =>
          build.voxelStorageBucket && build.voxelStoragePath
            ? [`${build.voxelStorageBucket}:${build.voxelStoragePath}`]
            : [],
        ),
      ),
    };
  });
  if (!snapshot) return false;

  const storageConfigured = hasSupabaseStorageConfig();
  const hasTrackedRemoteObjects =
    snapshot.buildUploads.length > 0 ||
    snapshot.builds.some(
      (build) =>
        Boolean(build.voxelStorageBucket && build.voxelStoragePath) ||
        build._count.arenaArtifacts > 0,
    );
  if (!storageConfigured && hasTrackedRemoteObjects) {
    throw new Error("Storage configuration is required to purge remote private artifacts");
  }
  if (storageConfigured) {
    const variantStorageRefs = await listStealthBuildStorageRefs(
      snapshot.variants.map((variant) => variant.id),
    );
    await deleteSupabaseStorageObjects(
      [
        ...snapshot.buildUploads,
        ...variantStorageRefs,
        ...snapshot.builds.flatMap((build) =>
          build.voxelStorageBucket && build.voxelStoragePath
            ? [{ bucket: build.voxelStorageBucket, path: build.voxelStoragePath }]
            : [],
        ),
      ].filter((ref) => !snapshot.survivingStorageRefs.has(`${ref.bucket}:${ref.path}`)),
    );
    await deleteArenaBuildArtifacts({
      retiringBuilds: snapshot.builds,
      survivingChecksums: snapshot.survivingChecksums,
      deleteStorage: deleteSupabaseStorageObjects,
    });
  }

  await prisma.$transaction(async (tx) => {
    const experiment = await lockExperiment(tx, snapshot.experimentId);
    if (
      !experiment ||
      experiment.status !== "CLOSED" ||
      !experiment.retentionDeleteAt ||
      experiment.retentionDeleteAt > now
    ) {
      return;
    }
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    const variantIds = variants.map((variant) => variant.id);
    const modelIds = variants.map((variant) => variant.modelId);
    await tx.arenaVoteJob.deleteMany({ where: { stealthVariantId: { in: variantIds } } });
    await tx.vote.deleteMany({ where: { matchup: { stealthVariantId: { in: variantIds } } } });
    await tx.matchup.deleteMany({ where: { stealthVariantId: { in: variantIds } } });
    await tx.stealthCohortUpload.deleteMany({ where: { experimentId: experiment.id } });
    await tx.stealthGenerationResult.deleteMany({
      where: { run: { variantId: { in: variantIds } } },
    });
    await tx.stealthGenerationRun.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.stealthEndpointCredential.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.build.deleteMany({ where: { modelId: { in: modelIds } } });
    await tx.stealthVariant.deleteMany({ where: { id: { in: variantIds } } });
    await tx.model.deleteMany({ where: { id: { in: modelIds } } });
    await tx.stealthExperiment.delete({ where: { id: experiment.id } });
  });
  invalidateStealthSamplingCache();
  return true;
}
