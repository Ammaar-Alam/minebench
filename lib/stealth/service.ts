import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type OrganizationRole,
  type StealthExportPolicy,
  type StealthExperimentStatus,
  type StealthGenerationResultStatus,
  type StealthVariantStatus,
} from "@prisma/client";
import { getSnapshotArtifactRef } from "@/lib/arena/buildSnapshotArtifacts";
import { getArenaBuildStreamArtifactFetchRefs } from "@/lib/arena/buildStream";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { MAX_BLOCKS_BY_GRID } from "@/lib/ai/limits";
import {
  BENCHMARK_PROMPT_COHORT_ID,
  BENCHMARK_PROMPT_MAP,
} from "@/lib/benchmark/prompts";
import { getPalette } from "@/lib/blocks/palettes";
import { prisma } from "@/lib/prisma";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getBuildStorageBucketFromEnv,
  getSupabaseStorageConfig,
} from "@/lib/storage/buildPayload";
import {
  decryptStealthEndpointConfig,
  encryptStealthEndpointConfig,
  stealthEndpointConfigToGenerateVoxelBuildArgs,
  type StealthEndpointConfig,
} from "@/lib/stealth/credentials";
import {
  ensureStealthBuildArtifacts,
  persistStealthBuild,
} from "@/lib/stealth/generation";
import {
  normalizeStealthSlug,
  opaqueStealthModelKey,
} from "@/lib/stealth/policy";
import { invalidateStealthSamplingCache } from "@/lib/stealth/sampling";
import { validateVoxelBuild } from "@/lib/voxel/validate";

export type StealthActor =
  | { organizationUser: { userId: string } }
  | { minebenchAdmin: true };

export type CohortPrompt = {
  slug: string;
  text: string;
  prompt: { id: string };
};

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

export type UploadedStealthBuildInput = {
  promptSlug: string;
  build: unknown;
  generationTimeMs?: number | null;
};

export type CompleteUploadedStealthCohortInput = {
  variantId?: string;
  codename: string;
  builds: UploadedStealthBuildInput[];
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
    generationFailureCount: number;
    lastGenerationError: string | null;
    cohortGeneratedAt: Date | null;
    decisiveVotes: number;
    totalVotes: number;
    latestGenerationRun: {
      id: string;
      status: string;
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
        build: {
          blockCount: number;
        } | null;
      }>;
    } | null;
  }>;
};

type PrismaExecutor = typeof prisma | Prisma.TransactionClient;

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

const GRID_SIZE = 256 as const;
const PALETTE = "simple" as const;
const MODE = "precise";
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const MAX_GENERATION_ATTEMPTS = 10;
const MAX_GENERATION_CONCURRENCY = 4;
const STORAGE_DELETE_BATCH_SIZE = 100;
const CONFIGURABLE_EXPERIMENT_STATUSES: readonly StealthExperimentStatus[] = ["DRAFT"];
const CONFIGURABLE_VARIANT_STATUSES: readonly StealthVariantStatus[] = ["DRAFT", "GENERATING"];

export function canManageOrganizationMembers(role: OrganizationRole | "MINEBENCH_ADMIN"): boolean {
  return role === "ADMIN" || role === "MINEBENCH_ADMIN";
}

export function canOperateEvaluation(role: OrganizationRole | "MINEBENCH_ADMIN"): boolean {
  return role === "ADMIN" || role === "MEMBER" || role === "MINEBENCH_ADMIN";
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

function sanitizeOperationalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Operation failed");
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|authorization|x-api-key|key)["'\s:=]+[A-Za-z0-9._~+/-]+=*/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s"'`]+/gi, "[endpoint]")
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

async function assertEvaluationOperator(
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

async function lockExperiment(
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

async function lockVariant(
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

async function assertNoCheckpointData(
  db: PrismaExecutor,
  variantId: string,
  modelId: string,
): Promise<void> {
  const [buildCount, matchupCount, voteCount] = await Promise.all([
    db.build.count({ where: { modelId } }),
    db.matchup.count({ where: { stealthVariantId: variantId } }),
    db.vote.count({ where: { matchup: { stealthVariantId: variantId } } }),
  ]);
  if (buildCount > 0 || matchupCount > 0 || voteCount > 0) {
    throw new Error("A checkpoint with builds or votes is immutable");
  }
}

async function assertUploadCheckpointRetryable(
  db: PrismaExecutor,
  variant: Pick<LockedVariant, "id" | "modelId" | "source">,
): Promise<void> {
  const [buildCount, matchupCount, voteCount] = await Promise.all([
    db.build.count({ where: { modelId: variant.modelId } }),
    db.matchup.count({ where: { stealthVariantId: variant.id } }),
    db.vote.count({ where: { matchup: { stealthVariantId: variant.id } } }),
  ]);
  if (matchupCount > 0 || voteCount > 0) {
    throw new Error("A checkpoint with votes is immutable");
  }
  if (buildCount > 0 && variant.source !== "UPLOAD") {
    throw new Error("A checkpoint with endpoint builds cannot be converted to upload");
  }
}

async function countCompletedBuilds(db: PrismaExecutor, modelId: string, prompts: CohortPrompt[]) {
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

async function syncExperimentReadiness(
  db: Prisma.TransactionClient,
  experimentId: string,
): Promise<void> {
  const variants = await db.stealthVariant.findMany({
    where: { experimentId, status: { not: "WITHDRAWN" } },
    select: { status: true, generatedBuildCount: true, expectedBuildCount: true },
  });
  if (variants.length === 0) {
    await db.stealthExperiment.update({
      where: { id: experimentId },
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
  await db.stealthExperiment.update({
    where: { id: experimentId },
    data: { status: allReady ? "READY" : "GENERATING" },
  });
}

async function findOrInviteSupabaseAuthUserByEmail(email: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(sanitizeOperationalError(error));
    const found = data.users.find((user) => user.email?.trim().toLowerCase() === email);
    if (found) return found.id;
    if (data.users.length < 1000) break;
  }

  const siteUrl = (process.env.MINEBENCH_SITE_URL ?? "").trim().replace(/\/+$/, "");
  if (!siteUrl) throw new Error("Missing MINEBENCH_SITE_URL for the invitation redirect");
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
  const invitations = await prisma.organizationInvitation.findMany({
    where: { email, acceptedAt: null, revokedAt: null },
    select: { id: true, organizationId: true, role: true },
  });
  if (invitations.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const invitation of invitations) {
      await tx.organizationMembership.upsert({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: user.id,
          },
        },
        create: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
        },
        update: { role: invitation.role },
      });
      await tx.organizationInvitation.update({
        where: { id: invitation.id },
        data: {
          authUserId: user.id,
          acceptedById: user.id,
          acceptedAt: new Date(),
        },
      });
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
    if (user) {
      await tx.organizationMembership.upsert({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: user.id,
          },
        },
        create: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
        update: { role: "ADMIN" },
      });
    }
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
  const user = await findOrInviteOrganizationUserByEmail(email);
  await prisma.$transaction(async (tx) => {
    await assertOrganizationAdmin(tx, actor, organizationId);
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
    if (user) {
      await tx.organizationMembership.upsert({
        where: { organizationId_userId: { organizationId, userId: user.id } },
        create: { organizationId, userId: user.id, role },
        update: { role },
      });
    }
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
    await assertOrganizationAdmin(tx, actor, organizationId);
    const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (user && role !== "ADMIN") {
      await assertNotLastAdmin(tx, organizationId, user.id);
    }
    await tx.organizationInvitation.updateMany({
      where: { organizationId, email, revokedAt: null },
      data: { role },
    });
    if (user) {
      const updated = await tx.organizationMembership.updateMany({
        where: { organizationId, userId: user.id },
        data: { role },
      });
      if (updated.count === 0) throw new Error("Member not found");
    }
  });
}

export async function removeOrganizationMember(
  actor: StealthActor,
  organizationId: string,
  params: { email: string },
): Promise<void> {
  const email = normalizeEmail(params.email);
  await prisma.$transaction(async (tx) => {
    await assertOrganizationAdmin(tx, actor, organizationId);
    const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
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
  });
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
    where: { organizationId },
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
      checkpointCount: evaluation.variants.filter((variant) => variant.status !== "WITHDRAWN").length,
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
  const evaluation = await prisma.stealthExperiment.findFirst({
    where: { id: experimentId, organizationId },
    include: {
      organization: { select: { id: true, slug: true, name: true } },
      variants: {
        orderBy: { codename: "asc" },
        include: {
          credential: { select: { id: true } },
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
    if (!CONFIGURABLE_EXPERIMENT_STATUSES.includes(experiment.status)) {
      throw new Error("Activated evaluations cannot accept new checkpoints");
    }

    const existing = input.variantId
      ? await lockVariant(tx, input.variantId)
      : await lockVariantByCodename(tx, experiment.id, codename);
    if (existing) {
      if (existing.experimentId !== experiment.id) throw new Error("Checkpoint not found");
      if (!CONFIGURABLE_VARIANT_STATUSES.includes(existing.status)) {
        throw new Error("This checkpoint cannot be changed");
      }
      await assertNoCheckpointData(tx, existing.id, existing.modelId);
      await tx.stealthVariant.update({
        where: { id: existing.id },
        data: {
          codename,
          source: "ENDPOINT",
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
    return { variantId };
  });
}

export async function completeUploadedStealthCohort(
  actor: StealthActor,
  organizationId: string,
  experimentId: string,
  input: CompleteUploadedStealthCohortInput,
): Promise<{ variantId: string; runId: string }> {
  const codename = normalizeName(input.codename, "Codename", 80);
  const prompts = await prepareStealthCohortPrompts();
  const promptBySlug = new Map(prompts.map((prompt) => [prompt.slug, prompt]));
  const seen = new Set<string>();
  const validated = input.builds.map((upload) => {
    const promptSlug = normalizeStealthSlug(upload.promptSlug);
    const prompt = promptBySlug.get(promptSlug);
    if (!prompt) throw new Error(`Unknown prompt: ${upload.promptSlug}`);
    if (seen.has(promptSlug)) throw new Error(`Duplicate prompt: ${promptSlug}`);
    seen.add(promptSlug);
    const result = validateVoxelBuild(upload.build, {
      gridSize: GRID_SIZE,
      palette: getPalette(PALETTE),
      maxBlocks: MAX_BLOCKS_BY_GRID[GRID_SIZE],
    });
    if (!result.ok) {
      throw new Error(`${promptSlug}: ${sanitizeOperationalError(result.error)}`);
    }
    return {
      prompt,
      build: result.value.build,
      generationTimeMs: Math.max(0, Math.floor(upload.generationTimeMs ?? 0)),
    };
  });
  const missing = prompts.filter((prompt) => !seen.has(prompt.slug)).map((prompt) => prompt.slug);
  if (missing.length > 0) throw new Error(`Missing prompts: ${missing.join(", ")}`);
  if (validated.length !== prompts.length) throw new Error("Upload must include the complete cohort");

  const prepared = await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (!CONFIGURABLE_EXPERIMENT_STATUSES.includes(experiment.status)) {
      throw new Error("Activated evaluations cannot accept new checkpoints");
    }
    const existing = input.variantId
      ? await lockVariant(tx, input.variantId)
      : await lockVariantByCodename(tx, experiment.id, codename);
    if (existing) {
      if (existing.experimentId !== experiment.id) throw new Error("Checkpoint not found");
      if (!CONFIGURABLE_VARIANT_STATUSES.includes(existing.status)) {
        throw new Error("This checkpoint cannot be changed");
      }
      await assertUploadCheckpointRetryable(tx, existing);
      await tx.stealthVariant.update({
        where: { id: existing.id },
        data: {
          codename,
          source: "UPLOAD",
          endpointEnabled: false,
          checkpointFingerprint: null,
          expectedBuildCount: prompts.length,
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
      await tx.stealthEndpointCredential.deleteMany({ where: { variantId: existing.id } });
      return { variantId: existing.id, modelId: existing.modelId };
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
        source: "UPLOAD",
        modelId,
        endpointEnabled: false,
        expectedBuildCount: prompts.length,
      },
    });
    return { variantId, modelId };
  });

  const persisted: Array<{
    prompt: (typeof validated)[number]["prompt"];
    storedBuild: { id: string; blockCount: number };
    generationTimeMs: number;
  }> = [];
  for (const entry of validated) {
    const build = await persistStealthBuild({
      variantId: prepared.variantId,
      modelId: prepared.modelId,
      promptSlug: entry.prompt.slug,
      promptText: entry.prompt.text,
      build: entry.build,
      generationTimeMs: entry.generationTimeMs,
    });
    persisted.push({
      prompt: entry.prompt,
      storedBuild: build,
      generationTimeMs: entry.generationTimeMs,
    });
  }

  return prisma.$transaction(async (tx) => {
    const run = await tx.stealthGenerationRun.create({
      data: {
        variantId: prepared.variantId,
        status: "SUCCEEDED",
        promptCohortId: BENCHMARK_PROMPT_COHORT_ID,
        expectedBuildCount: prompts.length,
        completedBuildCount: prompts.length,
        failedBuildCount: 0,
        providerCallCount: 0,
        retryCount: 0,
        completedAt: new Date(),
        configuration: {
          source: "upload",
          gridSize: GRID_SIZE,
          palette: PALETTE,
          mode: MODE,
        } satisfies Prisma.InputJsonObject,
        results: {
          createMany: {
            data: persisted.map((entry) => ({
              promptId: entry.prompt.prompt.id,
              buildId: entry.storedBuild.id,
              status: "READY",
              attempts: 0,
              generationTimeMs: entry.generationTimeMs,
            })),
          },
        },
      },
      select: { id: true },
    });
    await tx.stealthVariant.update({
      where: { id: prepared.variantId },
      data: {
        status: "READY",
        generatedBuildCount: prompts.length,
        generationFailureCount: 0,
        cohortGeneratedAt: new Date(),
        lastGenerationError: null,
      },
    });
    await syncExperimentReadiness(tx, experimentId);
    return { variantId: prepared.variantId, runId: run.id };
  });
}

export async function prepareStealthCohortPrompts(): Promise<CohortPrompt[]> {
  const entries = Object.entries(BENCHMARK_PROMPT_MAP);
  const prompts = await Promise.all(
    entries.map(async ([slug, text]) => ({
      slug,
      text,
      prompt: await prisma.prompt.upsert({
        where: { text },
        create: { text, active: true },
        update: { active: true },
        select: { id: true },
      }),
    })),
  );
  return prompts.sort((a, b) => {
    if (a.slug === "astronaut") return -1;
    if (b.slug === "astronaut") return 1;
    return a.slug.localeCompare(b.slug);
  });
}

export async function createStealthGenerationRun(
  actor: StealthActor,
  organizationId: string,
  variantId: string,
  params: { maxAttempts: number; concurrency: number },
): Promise<{ runId: string }> {
  const prompts = await prepareStealthCohortPrompts();
  const maxAttempts = normalizePositiveInt(params.maxAttempts, "Attempts", MAX_GENERATION_ATTEMPTS) ?? 3;
  const concurrency =
    normalizePositiveInt(params.concurrency, "Concurrency", MAX_GENERATION_CONCURRENCY) ?? 1;

  return prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const variant = await lockVariant(tx, variantId);
    if (!variant) throw new Error("Checkpoint not found");
    const experiment = await lockExperiment(tx, variant.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Checkpoint not found");
    }
    if (experiment.status === "CLOSED") throw new Error("Closed evaluations are read-only");
    if (experiment.status !== "DRAFT" && experiment.status !== "GENERATING") {
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
    const completedBuildCount = await countCompletedBuilds(tx, variant.modelId, prompts);
    if (completedBuildCount === prompts.length) {
      throw new Error("The cohort is already complete");
    }

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

export async function attachWorkflowRunId(runId: string, workflowRunId: string): Promise<void> {
  const normalized = workflowRunId.trim();
  if (!normalized) throw new Error("Workflow run id is required");
  await prisma.stealthGenerationRun.update({
    where: { id: runId },
    data: { workflowRunId: normalized },
  });
}

export async function generateStealthPromptForRun(params: {
  runId: string;
  promptSlug: string;
}): Promise<void> {
  const prompts = await prepareStealthCohortPrompts();
  const entry = prompts.find((prompt) => prompt.slug === params.promptSlug);
  if (!entry) throw new Error("Prompt not found");
  const resultKey = { runId_promptId: { runId: params.runId, promptId: entry.prompt.id } };

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
    if (currentRun.status !== "RUNNING") return null;
    if (currentRun.variant.experiment.status === "CLOSED") return null;
    const prior = await tx.stealthGenerationResult.upsert({
      where: resultKey,
      create: {
        runId: currentRun.id,
        promptId: entry.prompt.id,
        status: "GENERATING",
      },
      update: {},
      select: { status: true, buildId: true },
    });
    if (prior.status === "READY" && prior.buildId) return null;
    await tx.stealthGenerationResult.update({
      where: resultKey,
      data: { status: "GENERATING", error: null },
    });
    return currentRun;
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
      await prisma.stealthGenerationResult.update({
        where: resultKey,
        data: {
          buildId: existing.id,
          status: "READY",
          attempts: 0,
          generationTimeMs: 0,
          error: null,
        },
      });
    } catch (error) {
      await prisma.stealthGenerationResult.update({
        where: resultKey,
        data: { status: "FAILED", error: sanitizeOperationalError(error) },
      });
    }
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  if (!run.variant.credential || !run.variant.endpointEnabled) {
    await prisma.stealthGenerationResult.update({
      where: resultKey,
      data: {
        status: "FAILED",
        error: "Endpoint credential is not available",
      },
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
    await prisma.stealthGenerationResult.update({
      where: resultKey,
      data: {
        status: "FAILED",
        attempts,
        error: sanitizeOperationalError(error),
      },
    });
    await refreshStealthGenerationProgress(run.id);
    return;
  }

  if (!generated.ok) {
    await prisma.stealthGenerationResult.update({
      where: resultKey,
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

  await prisma.stealthGenerationResult.update({
    where: resultKey,
    data: {
      status: "VALIDATING",
      attempts,
      generationTimeMs: generated.generationTimeMs,
      requestConfiguration: generated.requestConfiguration,
      error: null,
    },
  });

  try {
    const build = await persistStealthBuild({
      variantId: run.variant.id,
      modelId: run.variant.modelId,
      promptSlug: entry.slug,
      promptText: entry.text,
      build: generated.build,
      generationTimeMs: generated.generationTimeMs,
    });
    await prisma.stealthGenerationResult.update({
      where: resultKey,
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
    await prisma.stealthGenerationResult.update({
      where: resultKey,
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

export async function refreshStealthGenerationProgress(runId: string): Promise<void> {
  const run = await prisma.stealthGenerationRun.findUnique({
    where: { id: runId },
    select: { id: true, variantId: true, expectedBuildCount: true },
  });
  if (!run) return;
  const results = await prisma.stealthGenerationResult.findMany({
    where: { runId },
    orderBy: { updatedAt: "asc" },
    select: { status: true, attempts: true, error: true },
  });
  const completedBuildCount = results.filter((result) => result.status === "READY").length;
  const failedBuildCount = results.filter((result) => result.status === "FAILED").length;
  const providerCallCount = results.reduce((sum, result) => sum + result.attempts, 0);
  const retryCount = results.reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0);
  const lastError = [...results].reverse().find((result) => result.error)?.error ?? null;
  await prisma.$transaction([
    prisma.stealthGenerationRun.update({
      where: { id: run.id },
      data: {
        completedBuildCount,
        failedBuildCount,
        providerCallCount,
        retryCount,
        error: lastError,
      },
    }),
    prisma.stealthVariant.update({
      where: { id: run.variantId },
      data: {
        generatedBuildCount: completedBuildCount,
        generationFailureCount: failedBuildCount,
        lastGenerationError: lastError,
      },
    }),
  ]);
}

export async function finishStealthGenerationRun(runId: string): Promise<void> {
  await refreshStealthGenerationProgress(runId);
  await prisma.$transaction(async (tx) => {
    const locked = await lockGenerationRun(tx, runId);
    if (!locked) return;
    const run = await tx.stealthGenerationRun.findUnique({
      where: { id: runId },
      include: {
        variant: {
          include: {
            experiment: true,
          },
        },
      },
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

export async function freezeStealthEvaluation(
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
    if (!experiment.checkpointSetFrozenAt) {
      await tx.stealthExperiment.update({
        where: { id: experiment.id },
        data: { checkpointSetFrozenAt: new Date() },
      });
    }
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
      },
    });
    if (variants.length === 0) throw new Error("Add a checkpoint first");
    for (const variant of variants) {
      if (variant.status !== "READY") throw new Error(`${variant.codename} is not ready`);
      if (variant.expectedBuildCount === 0 || variant.generatedBuildCount !== variant.expectedBuildCount) {
        throw new Error(`${variant.codename} is incomplete`);
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
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id, status: "ACTIVE" },
      select: { modelId: true },
    });
    if (variants.length === 0) throw new Error("Evaluation has no active checkpoints");
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
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const experiment = await lockExperiment(tx, experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Evaluation not found");
    }
    if (experiment.status === "CLOSED") return;
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    const now = new Date();
    const retentionDays =
      params?.retentionDays === undefined
        ? experiment.retentionDays
        : normalizeRetentionDays(params.retentionDays);
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
        endedAt: now,
        retentionDays,
        retentionDeleteAt: new Date(now.getTime() + retentionDays * 86_400_000),
      },
    });
  });
  invalidateStealthSamplingCache();
}

export async function disableStealthEndpoint(
  actor: StealthActor,
  organizationId: string,
  variantId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertEvaluationOperator(tx, actor, organizationId);
    const variant = await lockVariant(tx, variantId);
    if (!variant) throw new Error("Checkpoint not found");
    const experiment = await lockExperiment(tx, variant.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
      throw new Error("Checkpoint not found");
    }
    if (experiment.status === "CLOSED") throw new Error("Closed evaluations are read-only");
    await tx.stealthVariant.update({
      where: { id: variant.id },
      data: { endpointEnabled: false },
    });
    await tx.stealthEndpointCredential.deleteMany({ where: { variantId: variant.id } });
  });
}

export async function deleteUnusedDraftEvaluation(
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
    if (experiment.status !== "DRAFT") throw new Error("Only unused drafts can be deleted");
    const variants = await tx.stealthVariant.findMany({
      where: { experimentId: experiment.id },
      select: { id: true, modelId: true },
    });
    const variantIds = variants.map((variant) => variant.id);
    const modelIds = variants.map((variant) => variant.modelId);
    const [buildCount, matchupCount, voteCount] = await Promise.all([
      tx.build.count({ where: { modelId: { in: modelIds } } }),
      tx.matchup.count({ where: { stealthVariantId: { in: variantIds } } }),
      tx.vote.count({ where: { matchup: { stealthVariantId: { in: variantIds } } } }),
    ]);
    if (buildCount > 0 || matchupCount > 0 || voteCount > 0) {
      throw new Error("Only unused drafts can be deleted");
    }
    await tx.stealthEndpointCredential.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.stealthGenerationResult.deleteMany({
      where: { run: { variantId: { in: variantIds } } },
    });
    await tx.stealthGenerationRun.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.stealthVariant.deleteMany({ where: { id: { in: variantIds } } });
    await tx.stealthExperiment.delete({ where: { id: experiment.id } });
    await tx.model.deleteMany({ where: { id: { in: modelIds } } });
  });
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

export async function lookupProtectedPublicBuildForStealthRelease(
  actor: StealthActor,
  organizationId: string,
  params: { variantId: string; publicModelKey: string },
): Promise<{ modelId: string; modelKey: string; displayName: string } | null> {
  await assertEvaluationOperator(prisma, actor, organizationId);
  const variant = await prisma.stealthVariant.findFirst({
    where: { id: params.variantId, experiment: { organizationId } },
    select: { id: true },
  });
  if (!variant) throw new Error("Checkpoint not found");
  const model = await prisma.model.findFirst({
    where: {
      key: params.publicModelKey,
      stealthVariant: null,
    },
    select: { id: true, key: true, displayName: true },
  });
  return model ? { modelId: model.id, modelKey: model.key, displayName: model.displayName } : null;
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
    const variant = await lockVariant(tx, input.variantId);
    if (!variant) throw new Error("Checkpoint not found");
    const experiment = await lockExperiment(tx, variant.experimentId);
    if (!experiment || experiment.organizationId !== organizationId) {
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

function currentStorageRefsForBuild(build: {
  id: string;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelSha256: string | null;
}): Array<{ bucket: string; path: string }> {
  const refs = new Map<string, { bucket: string; path: string }>();
  const add = (ref: { bucket: string; path: string } | null) => {
    if (!ref) return;
    if (!ref.bucket.trim() || !ref.path.trim()) return;
    refs.set(`${ref.bucket}:${ref.path}`, { bucket: ref.bucket, path: ref.path });
  };
  if (build.voxelStorageBucket && build.voxelStoragePath) {
    add({ bucket: build.voxelStorageBucket, path: build.voxelStoragePath });
  }
  for (const variant of ["full", "preview"] as const) {
    add(getSnapshotArtifactRef(build.id, variant, build.voxelSha256, "json"));
    add(getSnapshotArtifactRef(build.id, variant, build.voxelSha256, "binary"));
    for (const ref of getArenaBuildStreamArtifactFetchRefs(build.id, variant, build.voxelSha256)) {
      add(ref);
    }
  }
  return Array.from(refs.values());
}

async function deleteStorageObjects(refs: Array<{ bucket: string; path: string }>): Promise<void> {
  if (refs.length === 0) return;
  const config = getSupabaseStorageConfig();
  const byBucket = new Map<string, string[]>();
  for (const ref of refs) {
    const paths = byBucket.get(ref.bucket) ?? [];
    paths.push(ref.path);
    byBucket.set(ref.bucket, paths);
  }
  for (const [bucket, paths] of byBucket) {
    for (let index = 0; index < paths.length; index += STORAGE_DELETE_BATCH_SIZE) {
      const batch = paths.slice(index, index + STORAGE_DELETE_BATCH_SIZE);
      const response = await fetch(
        `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefixes: batch }),
        },
      );
      if (!response.ok) {
        throw new Error(`Storage deletion failed (${response.status})`);
      }
    }
  }
}

export async function purgeDueStealthEvaluations(
  actor: StealthActor,
  params?: { now?: Date; limit?: number },
): Promise<{ purged: number; evaluationIds: string[] }> {
  if (!isMineBenchAdmin(actor)) throw new Error("MineBench admin access is required");
  const now = params?.now ?? new Date();
  const limit = Math.max(1, Math.min(100, params?.limit ?? 25));
  const due = await prisma.stealthExperiment.findMany({
    where: {
      status: "CLOSED",
      retentionDeleteAt: { lte: now },
    },
    orderBy: { retentionDeleteAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const purged: string[] = [];
  for (const evaluation of due) {
    const result = await purgeStealthEvaluationIfDue(evaluation.id, now);
    if (result) purged.push(evaluation.id);
  }
  return { purged: purged.length, evaluationIds: purged };
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
      },
    });
    return { experimentId: experiment.id, variants, builds };
  });
  if (!snapshot) return false;

  await deleteStorageObjects(snapshot.builds.flatMap(currentStorageRefsForBuild));

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

export function defaultStealthRetentionDays(): number {
  return DEFAULT_RETENTION_DAYS;
}

export function defaultStealthBuildStorageBucket(): string {
  return getBuildStorageBucketFromEnv();
}
