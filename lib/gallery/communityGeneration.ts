import type { CustomBuildJob, Prisma } from "@prisma/client";
import { getAverageBenchmarkCostPerBuildUsd } from "@/lib/ai/modelBenchmarkProfiles";
import { MODEL_CATALOG, getModelByKey, type ModelKey } from "@/lib/ai/modelCatalog";
import { ARENA_BUILD_MODE, arenaBuildSetupWhere } from "@/lib/arena/eligibility";
import { sha256Hex } from "@/lib/custom-builds/hash";
import { generateCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { isCommunityArenaPrompt } from "@/lib/gallery/arenaImport";
import { normalizeGalleryNickname } from "@/lib/gallery/policy";
import { GalleryServiceError, addGalleryExample, requireMineBenchAdmin } from "@/lib/gallery/service";
import { GENERATE_JOB_MAX_ATTEMPTS } from "@/lib/generations/service";
import { prisma } from "@/lib/prisma";

export const DEFAULT_COMMUNITY_TOP = 10;
export const DEFAULT_COMMUNITY_MAX_COST_USD = 3;
const MINEBENCH_NICKNAME = "minebench";

// an unpublished CLI row left by a failed cleanup never blocks its slot
export const UNPUBLISHED_CLI_BUILD = {
  active: false,
  arenaImportPending: false,
  voxelStoragePath: { startsWith: "community/" },
} satisfies Prisma.BuildWhereInput;

export type RankedModel = { key: ModelKey; rank: number };
export type PlannedModel = RankedModel & { costUsd: number | null };
export type GalleryGenerationRequest =
  | { candidatePublicId: string; top?: number; maxCostUsd?: number }
  | { modelKey: ModelKey };
export type GalleryGenerationPlanItem = PlannedModel & {
  candidateId: string;
  publicId: string;
  promptId: string;
  promptText: string;
  gridSize: number;
  palette: string;
};

const costOf = getAverageBenchmarkCostPerBuildUsd as (key: ModelKey) => number | null;

// top ranked models under the price cap, or the explicit list, minus models already covered
export function planCommunityModels(opts: {
  ranked: RankedModel[];
  costOf: (key: ModelKey) => number | null;
  existing: Set<string>;
  top: number;
  maxCostUsd: number;
  explicit: ModelKey[];
}): PlannedModel[] {
  const rankOf = new Map(opts.ranked.map((model) => [model.key, model.rank]));
  const candidates: PlannedModel[] = opts.explicit.length > 0
    ? [...new Set(opts.explicit)].map((key) => ({ key, rank: rankOf.get(key) ?? Number.POSITIVE_INFINITY, costUsd: opts.costOf(key) }))
    : opts.ranked.map((model) => ({ ...model, costUsd: opts.costOf(model.key) }));
  const affordable = candidates.filter(({ costUsd }) =>
    costUsd == null ? opts.explicit.length > 0 : costUsd <= opts.maxCostUsd,
  );
  const picked = opts.explicit.length > 0 ? affordable : affordable.slice(0, opts.top);
  return picked.filter((model) => !opts.existing.has(model.key));
}

function generatableModelKeys(): Set<ModelKey> {
  return new Set(MODEL_CATALOG.filter((model) => model.enabled && !model.importOnly).map((model) => model.key));
}

export async function loadRankedModels(): Promise<RankedModel[]> {
  const latest = await prisma.modelRankSnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true },
  });
  if (!latest) return [];
  const rows = await prisma.modelRankSnapshot.findMany({
    where: { capturedAt: latest.capturedAt, model: { enabled: true, isBaseline: false, stealthVariant: null } },
    orderBy: { rank: "asc" },
    select: { rank: true, model: { select: { key: true } } },
  });
  const generatable = generatableModelKeys();
  return rows
    .filter((row) => generatable.has(row.model.key as ModelKey))
    .map((row) => ({ key: row.model.key as ModelKey, rank: row.rank }));
}

// built, importing, or already generating for this prompt
export async function coveredModelKeys(
  promptId: string,
  candidatePublicId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Set<string>> {
  const [built, imports, generating] = await Promise.all([
    client.build.findMany({
      where: {
        promptId,
        ...arenaBuildSetupWhere(),
        NOT: UNPUBLISHED_CLI_BUILD,
      },
      select: { model: { select: { key: true } } },
    }),
    client.customBuildJob.findMany({
      where: { status: { in: ["queued", "running"] }, type: "arena_import", payload: { path: ["promptId"], equals: promptId } },
      select: { customBuild: { select: { modelKey: true } } },
    }),
    // retried runs queue a job without the target, so match the build through any of its jobs
    // the job stays running until the finished build is published
    client.customBuild.findMany({
      where: {
        AND: [
          { jobs: { some: { type: "generate", payload: { path: ["galleryCandidateId"], equals: candidatePublicId } } } },
          { jobs: { some: { type: "generate", status: { in: ["queued", "running"] } } } },
        ],
      },
      select: { modelKey: true },
    }),
  ]);
  return new Set([
    ...built.map(({ model }) => model.key),
    ...[...imports.map(({ customBuild }) => customBuild), ...generating].flatMap(({ modelKey }) => (modelKey ? [modelKey] : [])),
  ]);
}

export async function planGalleryGenerations(request: GalleryGenerationRequest): Promise<GalleryGenerationPlanItem[]> {
  const modelWide = "modelKey" in request;
  if (modelWide && !generatableModelKeys().has(request.modelKey)) {
    throw new GalleryServiceError("invalid_model", "Choose an enabled catalog model.");
  }
  const candidates = await prisma.galleryCandidate.findMany({
    where: {
      selectedAt: { not: null },
      removedAt: null,
      adminHiddenAt: null,
      officialPromptId: { not: null },
      ...(modelWide ? {} : { publicId: request.candidatePublicId }),
    },
    orderBy: { selectedAt: "desc" },
    select: { id: true, publicId: true, promptText: true, officialPrompt: { select: { id: true, gridSize: true, palette: true } } },
  });
  const ranked = await loadRankedModels();
  const plan: GalleryGenerationPlanItem[] = [];
  for (const candidate of candidates) {
    const prompt = candidate.officialPrompt;
    if (!prompt || !isCommunityArenaPrompt(candidate.promptText)) continue;
    const models = planCommunityModels({
      ranked,
      costOf,
      existing: await coveredModelKeys(prompt.id, candidate.publicId),
      top: modelWide ? 1 : request.top ?? DEFAULT_COMMUNITY_TOP,
      maxCostUsd: modelWide ? Number.POSITIVE_INFINITY : request.maxCostUsd ?? DEFAULT_COMMUNITY_MAX_COST_USD,
      explicit: modelWide ? [request.modelKey] : [],
    });
    plan.push(...models.map((model) => ({
      ...model,
      candidateId: candidate.id,
      publicId: candidate.publicId,
      promptId: prompt.id,
      gridSize: prompt.gridSize,
      palette: prompt.palette,
      promptText: candidate.promptText,
    })));
  }
  return plan;
}

export async function loadMineBenchGalleryPublisher() {
  const publisher = await prisma.user.findUnique({
    where: { publicNicknameNormalized: MINEBENCH_NICKNAME },
    select: {
      id: true,
      publicNickname: true,
      isMineBenchAdmin: true,
      gallerySuspendedAt: true,
      deletedAt: true,
      authDeletedAt: true,
    },
  });
  if (
    !publisher?.publicNickname ||
    !publisher.isMineBenchAdmin ||
    publisher.gallerySuspendedAt ||
    publisher.deletedAt ||
    publisher.authDeletedAt ||
    normalizeGalleryNickname(publisher.publicNickname).normalized !== MINEBENCH_NICKNAME
  ) {
    throw new Error("An active MineBench Gallery admin account is required.");
  }
  return publisher;
}

// the worker runs these with its own provider keys and publishes each success to the prompt
export async function queueGalleryGenerations(adminId: string, request: GalleryGenerationRequest) {
  await requireMineBenchAdmin(adminId);
  const publisher = await loadMineBenchGalleryPublisher();
  const plan = await planGalleryGenerations(request);
  const byCandidate = new Map<string, GalleryGenerationPlanItem[]>();
  for (const item of plan) byCandidate.set(item.candidateId, [...(byCandidate.get(item.candidateId) ?? []), item]);
  const queued: GalleryGenerationPlanItem[] = [];
  for (const [candidateId, items] of byCandidate) {
    // concurrent requests serialize on the candidate and recheck coverage, so nothing is paid for twice
    queued.push(...await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "GalleryCandidate" WHERE id = ${candidateId} FOR UPDATE`;
      const covered = await coveredModelKeys(items[0].promptId, items[0].publicId, tx);
      const fresh = items.filter((item) => !covered.has(item.key));
      for (const item of fresh) await tx.customBuild.create({ data: queuedGenerationData(item, publisher.id) });
      return fresh;
    }));
  }
  return {
    queued: queued.length,
    costUsd: queued.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
  };
}

function queuedGenerationData(item: GalleryGenerationPlanItem, ownerId: string): Prisma.CustomBuildUncheckedCreateInput {
  const model = getModelByKey(item.key);
  return {
    publicId: generateCustomBuildPublicId(),
    ownerId,
    status: "queued",
    currentStage: "queued",
    promptText: item.promptText,
    promptSha256: sha256Hex(item.promptText),
    gridSize: item.gridSize,
    palette: item.palette,
    mode: ARENA_BUILD_MODE,
    modelKind: "catalog",
    modelKey: model.key,
    modelProvider: model.provider,
    modelId: model.modelId,
    modelDisplayName: model.displayName,
    openRouterModelId: model.openRouterModelId,
    // OpenRouter-only catalog models keep their route, matching Sandbox resolution
    preferOpenRouter: Boolean(model.forceOpenRouter),
    jobs: {
      create: {
        type: "generate",
        status: "queued",
        maxAttempts: GENERATE_JOB_MAX_ATTEMPTS,
        // user generations go first
        priority: -1,
        payload: { serverKeys: true, galleryCandidateId: item.publicId },
      },
    },
    events: { create: { seq: 1, type: "queued", data: { stage: "queued" } } },
  };
}

function galleryPublishTarget(payload: Prisma.JsonValue | null): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload.serverKeys === true && typeof payload.galleryCandidateId === "string" ? payload.galleryCandidateId : null;
}

// a finished MineBench run becomes a Gallery example, which queues its arena import
export async function publishMineBenchGeneration(job: Pick<CustomBuildJob, "customBuildId">): Promise<void> {
  const build = await prisma.customBuild.findUnique({
    where: { id: job.customBuildId },
    select: {
      status: true,
      ownerId: true,
      publicId: true,
      // retries queue a fresh job, so the target lives on the first one
      jobs: { where: { type: "generate" }, orderBy: { createdAt: "asc" }, take: 1, select: { payload: true } },
    },
  });
  const candidatePublicId = galleryPublishTarget(build?.jobs[0]?.payload ?? null);
  if (!candidatePublicId || build?.status !== "succeeded" || !build.ownerId) return;
  await addGalleryExample(build.ownerId, candidatePublicId, { generationId: build.publicId, postAnonymously: false });
}
