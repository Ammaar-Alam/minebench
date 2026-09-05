import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { sha256Hex } from "@/lib/custom-builds/hash";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { deleteCustomBuildArtifact } from "@/lib/custom-builds/storage";
import {
  sendGalleryAccountNotification,
  sendGalleryAdminNotification,
} from "@/lib/gallery/email";
import {
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryAttribution,
  normalizeGalleryNickname,
  normalizeGalleryPrompt,
  normalizeGalleryPromptIdentity,
  publicGalleryTextError,
  resolveGalleryModelLabel,
} from "@/lib/gallery/policy";
import { prisma } from "@/lib/prisma";
import {
  PUBLIC_SESSION_ONLINE_MS,
  PUBLIC_SESSION_RETENTION_MS,
} from "@/lib/publicPresence";
import { hashVoteSession } from "@/lib/voteBlock";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HOSTED_GENERATION_LIMIT = 2_147_483_647;

async function deliverGalleryEmail(task: Promise<void>, context: string) {
  try {
    await task;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    console.error("Gallery email delivery failed", { context, code });
    try {
      await prisma.galleryModerationRecord.create({
        data: {
          kind: "ADMIN_ACTION",
          target: "ACCOUNT",
          action: "email_delivery_failed",
          note: context,
          safeSnapshot: { code },
          purgeAt: new Date(Date.now() + RETENTION_MS),
        },
      });
    } catch (recordError) {
      const recordCode = recordError && typeof recordError === "object" && "code" in recordError
        ? String(recordError.code)
        : "unknown";
      console.error("Gallery email failure recording failed", { context, code: recordCode });
    }
  }
}

export class GalleryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GalleryServiceError";
  }
}

function generateGalleryPublicId(): string {
  return `gal_${randomBytes(12).toString("base64url")}`;
}

const publicCandidateWhere = {
  removedAt: null,
  adminHiddenAt: null,
  OR: [
    { selectedAt: { not: null } },
    { uploader: { gallerySuspendedAt: null } },
  ],
} satisfies Prisma.GalleryCandidateWhereInput;

const publicExampleWhere = {
  removedAt: null,
  adminHiddenAt: null,
  contributor: { gallerySuspendedAt: null },
  customBuild: { removedAt: null, status: "succeeded" as const },
} satisfies Prisma.GalleryExampleWhereInput;

const candidateSelect = {
  id: true,
  publicId: true,
  uploaderId: true,
  promptText: true,
  upvoteCount: true,
  publishedAt: true,
  selectedAt: true,
  postAnonymously: true,
  uploader: {
    select: { publicNickname: true },
  },
} satisfies Prisma.GalleryCandidateSelect;

const galleryModelSelect = {
  modelKind: true,
  modelId: true,
  modelDisplayName: true,
} satisfies Prisma.CustomBuildSelect;

const exampleSelect = {
  id: true,
  candidateId: true,
  createdAt: true,
  postAnonymously: true,
  contributor: { select: { publicNickname: true } },
  customBuild: {
    select: {
      publicId: true,
      completedAt: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      buildByteSize: true,
      generationTimeMs: true,
      buildSha256: true,
      ...galleryModelSelect,
      artifacts: {
        where: { kind: { in: ["preview_svg", "preview_mbv4", "viewer_mbv4", "viewer_mbf1"] } },
        select: { kind: true },
      },
    },
  },
} satisfies Prisma.GalleryExampleSelect;

type CandidateRow = Prisma.GalleryCandidateGetPayload<{ select: typeof candidateSelect }>;
type ExampleRow = Prisma.GalleryExampleGetPayload<{ select: typeof exampleSelect }>;
type GalleryModelRow = Prisma.CustomBuildGetPayload<{ select: typeof galleryModelSelect }>;

const candidateListSelect = {
  ...candidateSelect,
  examples: {
    where: publicExampleWhere,
    select: exampleSelect,
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    take: 2,
  },
  _count: {
    select: { examples: { where: publicExampleWhere } },
  },
} satisfies Prisma.GalleryCandidateSelect;

function publicGalleryModel(model: GalleryModelRow) {
  const kind =
    model.modelKind === "openrouter"
      ? "openrouter"
      : model.modelKind === "custom"
        ? "custom"
        : "catalog";
  return {
    kind,
    label: resolveGalleryModelLabel({
      kind,
      displayName: model.modelDisplayName,
      modelId: model.modelId,
    }),
  };
}

function publicExample(example: ExampleRow) {
  const kinds = new Set(example.customBuild.artifacts.map((artifact) => artifact.kind));
  return {
    id: example.id,
    buildId: example.customBuild.publicId,
    attribution: galleryAttribution({
      postAnonymously: example.postAnonymously,
      publicNickname: example.contributor.publicNickname,
    }),
    createdAt: example.createdAt.toISOString(),
    runAt: (example.customBuild.completedAt ?? example.createdAt).toISOString(),
    model: publicGalleryModel(example.customBuild),
    gridSize: example.customBuild.gridSize,
    palette: example.customBuild.palette === "advanced" ? "advanced" as const : "simple" as const,
    blockCount: example.customBuild.blockCount,
    jsonBytes: example.customBuild.buildByteSize,
    generationTimeMs: example.customBuild.generationTimeMs,
    checksum: example.customBuild.buildSha256,
    previewUrl: kinds.has("preview_svg")
      ? `/api/gallery/examples/${example.id}/preview`
      : null,
    thumbnailUrl: kinds.has("preview_mbv4")
      ? `/api/gallery/examples/${example.id}/thumbnail`
      : null,
    viewerUrl: kinds.has("viewer_mbv4") || kinds.has("viewer_mbf1")
      ? `/api/gallery/examples/${example.id}/viewer`
      : null,
  };
}

function publicCandidate(
  candidate: CandidateRow,
  cover: ExampleRow | null,
  exampleCount: number,
  upvoted = false,
  viewerUserId?: string | null,
  alternate?: ExampleRow | null,
  matchedModels: GalleryModelRow[] = [],
  models: GalleryModelRow[] = [],
) {
  const modelLabels = [...new Set(
    [cover?.customBuild, alternate?.customBuild, ...models]
      .filter((model): model is GalleryModelRow => Boolean(model))
      .map((model) => publicGalleryModel(model).label),
  )];
  return {
    id: candidate.publicId,
    prompt: candidate.promptText,
    attribution: galleryAttribution({
      postAnonymously: candidate.postAnonymously,
      publicNickname: candidate.uploader.publicNickname,
    }),
    upvoteCount: candidate.upvoteCount,
    upvoted,
    selected: Boolean(candidate.selectedAt),
    canRemove: Boolean(
      viewerUserId && candidate.uploaderId === viewerUserId && !candidate.selectedAt,
    ),
    publishedAt: candidate.publishedAt.toISOString(),
    exampleCount,
    cover: cover ? publicExample(cover) : null,
    alternate: alternate ? publicExample(alternate) : null,
    modelLabels,
    matchedModelLabels: [...new Set(matchedModels.map((model) => publicGalleryModel(model).label))],
  };
}

export type GalleryCandidatePayload = ReturnType<typeof publicCandidate>;
export type GalleryExamplePayload = ReturnType<typeof publicExample>;

export type GallerySort = "top" | "new" | "official";

export function normalizeGallerySort(sort?: string | null): GallerySort {
  return sort === "new" || sort === "official" ? sort : "top";
}

function galleryCandidateOrder(sort: GallerySort): Prisma.GalleryCandidateOrderByWithRelationInput[] {
  if (sort === "top") return [{ upvoteCount: "desc" }, { publishedAt: "desc" }, { id: "desc" }];
  if (sort === "official") return [{ selectedAt: "desc" }, { id: "desc" }];
  return [{ publishedAt: "desc" }, { id: "desc" }];
}

function galleryCandidateScope(sort: GallerySort): Prisma.GalleryCandidateWhereInput {
  return sort === "official" ? { AND: [publicCandidateWhere, { selectedAt: { not: null } }] } : publicCandidateWhere;
}

export async function listGalleryCandidates(options: {
  sort: GallerySort;
  cursor?: string | null;
  limit?: number;
  sessionId?: string | null;
  userId?: string | null;
  query?: string | null;
}) {
  const limit = Math.max(1, Math.min(options.limit ?? 24, 48));
  const query = options.query?.trim().slice(0, 100);
  const matchesCustomPrefix = Boolean(query && "custom".includes(query.toLowerCase()));
  const cursor = decodeGalleryCursor(options.cursor);
  const cursorWhere: Prisma.GalleryCandidateWhereInput = cursor
    ? options.sort === "top"
      ? {
          OR: [
            { upvoteCount: { lt: cursor.score } },
            {
              upvoteCount: cursor.score,
              OR: [
                { publishedAt: { lt: cursor.publishedAt } },
                { publishedAt: cursor.publishedAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : options.sort === "official"
        ? {
            OR: [
              { selectedAt: { lt: cursor.publishedAt } },
              { selectedAt: cursor.publishedAt, id: { lt: cursor.id } },
            ],
          }
      : {
          OR: [
            { publishedAt: { lt: cursor.publishedAt } },
            { publishedAt: cursor.publishedAt, id: { lt: cursor.id } },
          ],
        }
    : {};
  // ponytail: add indexed search when Gallery volume makes contains queries measurable
  const searchExampleWhere = query
    ? {
        ...publicExampleWhere,
        customBuild: {
          ...publicExampleWhere.customBuild,
          OR: [
            { modelDisplayName: { contains: query, mode: "insensitive" as const } },
            { modelId: { contains: query, mode: "insensitive" as const } },
            ...(matchesCustomPrefix ? [{ modelKind: "custom" }] : []),
          ],
        },
      } satisfies Prisma.GalleryExampleWhereInput
    : null;
  const queryWhere: Prisma.GalleryCandidateWhereInput = query
    ? {
        OR: [
          { promptText: { contains: query, mode: "insensitive" } },
          { examples: { some: searchExampleWhere! } },
        ],
      }
    : {};
  const rows = await prisma.galleryCandidate.findMany({
    where: { AND: [galleryCandidateScope(options.sort), cursorWhere, queryWhere] },
    select: candidateListSelect,
    orderBy: galleryCandidateOrder(options.sort),
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const voteIdentities = [
    options.sessionId ? { sessionId: options.sessionId } : null,
    options.userId ? { userId: options.userId } : null,
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  const [votes, modelExamples] = await Promise.all([
    voteIdentities.length > 0
      ? prisma.galleryVote.findMany({
          where: { OR: voteIdentities, candidateId: { in: page.map((row) => row.id) } },
          select: { candidateId: true },
        })
      : [],
    page.length > 0
      ? prisma.galleryExample.findMany({
          where: { candidateId: { in: page.map((row) => row.id) }, ...publicExampleWhere },
          select: { candidateId: true, customBuild: { select: galleryModelSelect } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [],
  ]);
  const upvoted = new Set(votes.map((vote) => vote.candidateId));
  const modelsByCandidate = new Map<string, GalleryModelRow[]>();
  for (const example of modelExamples) {
    const models = modelsByCandidate.get(example.candidateId) ?? [];
    models.push(example.customBuild);
    modelsByCandidate.set(example.candidateId, models);
  }
  const modelQuery = query?.toLowerCase();
  const last = page.at(-1);
  return {
    items: page.map((candidate) => {
      const models = modelsByCandidate.get(candidate.id) ?? [];
      const matchedModels = modelQuery
        ? models.filter((model) =>
            model.modelDisplayName.toLowerCase().includes(modelQuery)
            || model.modelId.toLowerCase().includes(modelQuery)
            || (matchesCustomPrefix && model.modelKind === "custom"),
          )
        : [];
      return publicCandidate(
        candidate,
        candidate.examples[0] ?? null,
        candidate._count.examples,
        upvoted.has(candidate.id),
        options.userId,
        candidate.examples[1] ?? null,
        matchedModels,
        models,
      );
    }),
    nextCursor: rows.length > limit && last
      ? encodeGalleryCursor({
          score: options.sort === "top" ? last.upvoteCount : 0,
          publishedAt: options.sort === "official" ? last.selectedAt ?? last.publishedAt : last.publishedAt,
          id: last.id,
        })
      : null,
  };
}

export async function getGalleryCandidate(
  publicId: string,
  options: {
    sessionId?: string | null;
    userId?: string | null;
    examplesCursor?: string | null;
    examplesLimit?: number;
    navigationSort?: GallerySort;
  } = {},
) {
  const candidate = await prisma.galleryCandidate.findFirst({
    where: { publicId, ...publicCandidateWhere },
    select: candidateSelect,
  });
  if (!candidate) return null;
  const limit = Math.max(1, Math.min(options.examplesLimit ?? 24, 48));
  const cursor = decodeGalleryCursor(options.examplesCursor);
  const navigationSort = options.navigationSort === "official" && !candidate.selectedAt
    ? null
    : options.navigationSort;
  const [cover, exampleCount, upvoted, previousCandidates, nextCandidates] = await Promise.all([
    prisma.galleryExample.findFirst({
      where: { candidateId: candidate.id, ...publicExampleWhere },
      select: exampleSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.galleryExample.count({ where: { candidateId: candidate.id, ...publicExampleWhere } }),
    options.sessionId || options.userId
      ? prisma.galleryVote.findFirst({
        where: {
          candidateId: candidate.id,
          OR: [
            options.sessionId ? { sessionId: options.sessionId } : null,
            options.userId ? { userId: options.userId } : null,
          ].filter((value): value is NonNullable<typeof value> => Boolean(value)),
        },
        select: { id: true },
      })
      : null,
    navigationSort
      ? prisma.galleryCandidate.findMany({
          where: galleryCandidateScope(navigationSort),
          cursor: { id: candidate.id },
          skip: 1,
          take: -1,
          select: { publicId: true },
          orderBy: galleryCandidateOrder(navigationSort),
        })
      : [],
    navigationSort
      ? prisma.galleryCandidate.findMany({
          where: galleryCandidateScope(navigationSort),
          cursor: { id: candidate.id },
          skip: 1,
          take: 1,
          select: { publicId: true },
          orderBy: galleryCandidateOrder(navigationSort),
        })
      : [],
  ]);
  const additional = await prisma.galleryExample.findMany({
    where: {
      candidateId: candidate.id,
      ...publicExampleWhere,
      ...(cover ? { id: { not: cover.id } } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.publishedAt } },
              { createdAt: cursor.publishedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    select: exampleSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = additional.slice(0, limit);
  const last = page.at(-1);
  return {
    ...publicCandidate(candidate, cover, exampleCount, Boolean(upvoted), options.userId),
    examples: [options.examplesCursor ? null : cover, ...page]
      .filter((value): value is ExampleRow => Boolean(value))
      .map(publicExample),
    nextExamplesCursor: additional.length > limit && last
      ? encodeGalleryCursor({ score: 0, publishedAt: last.createdAt, id: last.id })
      : null,
    navigation: navigationSort
      ? {
          sort: navigationSort,
          previousId: previousCandidates[0]?.publicId ?? null,
          nextId: nextCandidates[0]?.publicId ?? null,
        }
      : null,
  };
}

async function requirePublishingAccount(userId: string) {
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      publicNickname: true,
      gallerySuspendedAt: true,
    },
  });
  if (!account) throw new GalleryServiceError("authentication_required", "Sign in to contribute.");
  if (account.gallerySuspendedAt) {
    throw new GalleryServiceError("account_suspended", "Account suspended.");
  }
  return account;
}

function galleryUrl(path: string): string {
  return `${(process.env.MINEBENCH_SITE_URL?.trim() || "https://minebench.ai").replace(/\/+$/, "")}${path}`;
}

function galleryAdminUrl(): string {
  return galleryUrl("/admin/gallery");
}

async function recordFilterRejection(args: {
  userId: string;
  target: "CANDIDATE" | "EXAMPLE" | "ACCOUNT";
  content: string;
}) {
  const now = new Date();
  const recent = await prisma.galleryModerationRecord.count({
    where: {
      kind: "FILTER_REJECTION",
      actorUserId: args.userId,
      createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  const rejection = await prisma.galleryModerationRecord.create({
    data: {
      kind: "FILTER_REJECTION",
      target: args.target,
      actorUserId: args.userId,
      subjectUserId: args.userId,
      action: "blocked_language",
      safeSnapshot: { content: args.content },
      purgeAt: new Date(now.getTime() + RETENTION_MS),
    },
    select: { actor: { select: { email: true } } },
  });
  if (recent < 3) {
    await deliverGalleryEmail(
      sendGalleryAdminNotification({
        heading: "Public submission rejected",
        intro: "A Gallery public-text check rejected a contribution.",
        details: { Account: rejection.actor?.email, Type: args.target, Content: args.content },
        action: { label: "Review submission", href: galleryAdminUrl() },
      }),
      "filter_rejection",
    );
  }
}

function assertAttribution(account: { publicNickname: string | null }, postAnonymously: boolean) {
  if (!postAnonymously && !account.publicNickname) {
    throw new GalleryServiceError("nickname_required", "Choose a public nickname or post anonymously.");
  }
}

async function loadEligibleGeneration(ownerId: string, publicId: string) {
  return prisma.customBuild.findFirst({
    where: {
      publicId,
      ownerId,
      status: "succeeded",
      removedAt: null,
      objectsDeletedAt: null,
      artifacts: { some: { kind: "build_json" } },
    },
    select: {
      id: true,
      promptText: true,
      modelKind: true,
      modelDisplayName: true,
      modelId: true,
    },
  });
}

export async function submitGalleryCandidate(
  userId: string,
  input: {
    prompt?: string;
    generationId?: string;
    postAnonymously: boolean;
  },
) {
  const account = await requirePublishingAccount(userId);
  assertAttribution(account, input.postAnonymously);
  const generation = input.generationId
    ? await loadEligibleGeneration(userId, input.generationId)
    : null;
  if (input.generationId && !generation) {
    throw new GalleryServiceError("generation_not_available", "Saved generation not available.");
  }
  const prompt = normalizeGalleryPrompt(generation?.promptText ?? input.prompt ?? "");
  if (!prompt || prompt.length > 800) {
    throw new GalleryServiceError("invalid_prompt", "Enter a prompt to submit.");
  }
  if (publicGalleryTextError(prompt)) {
    await recordFilterRejection({ userId, target: "CANDIDATE", content: prompt });
    throw new GalleryServiceError("prompt_rejected", "This prompt can't be submitted. Try a different prompt.");
  }
  if (
    generation?.modelKind === "custom" &&
    publicGalleryTextError(`${generation.modelDisplayName} ${generation.modelId}`)
  ) {
    await recordFilterRejection({
      userId,
      target: "EXAMPLE",
      content: `${generation.modelDisplayName} ${generation.modelId}`,
    });
    throw new GalleryServiceError("model_label_rejected", "Choose a different public model label.");
  }

  const proposedId = randomBytes(16).toString("hex");
  const promptKey = sha256Hex(normalizeGalleryPromptIdentity(prompt));
  const legacyPromptKey = sha256Hex(prompt);
  if (legacyPromptKey !== promptKey) {
    try {
      await prisma.galleryCandidate.updateMany({
        where: { promptKey: legacyPromptKey },
        data: { promptKey },
      });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") throw error;
    }
  }
  const candidate = await prisma.$transaction(async (tx) => {
    const row = await tx.galleryCandidate.upsert({
      where: { promptKey },
      create: {
        id: proposedId,
        publicId: generateGalleryPublicId(),
        promptText: prompt,
        promptKey,
        uploaderId: userId,
        postAnonymously: input.postAnonymously,
      },
      update: {},
      select: { id: true, publicId: true },
    });
    if (row.id === proposedId && generation) {
      await tx.galleryExample.create({
        data: {
          candidateId: row.id,
          customBuildId: generation.id,
          contributorId: userId,
          postAnonymously: input.postAnonymously,
        },
      });
    }
    return { ...row, created: row.id === proposedId };
  });
  const serialized = await getGalleryCandidate(candidate.publicId);
  if (!serialized) {
    throw new GalleryServiceError("duplicate_unavailable", "This prompt has already been submitted.");
  }
  return { created: candidate.created, candidate: serialized };
}

export async function addGalleryExample(
  userId: string,
  candidatePublicId: string,
  input: { generationId: string; postAnonymously: boolean },
) {
  const account = await requirePublishingAccount(userId);
  assertAttribution(account, input.postAnonymously);
  const [candidate, generation] = await Promise.all([
    prisma.galleryCandidate.findFirst({
      where: { publicId: candidatePublicId, ...publicCandidateWhere },
      select: { id: true, promptText: true },
    }),
    loadEligibleGeneration(userId, input.generationId),
  ]);
  if (!candidate) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
  if (
    !generation ||
    normalizeGalleryPromptIdentity(generation.promptText) !== normalizeGalleryPromptIdentity(candidate.promptText)
  ) {
    throw new GalleryServiceError("generation_mismatch", "Choose a successful generation for this exact prompt.");
  }
  if (
    generation.modelKind === "custom" &&
    publicGalleryTextError(`${generation.modelDisplayName} ${generation.modelId}`)
  ) {
    await recordFilterRejection({
      userId,
      target: "EXAMPLE",
      content: `${generation.modelDisplayName} ${generation.modelId}`,
    });
    throw new GalleryServiceError("model_label_rejected", "Choose a different public model label.");
  }
  const id = randomBytes(16).toString("hex");
  return prisma.$transaction(async (tx) => {
    const example = await tx.galleryExample.upsert({
      where: {
        candidateId_customBuildId: {
          candidateId: candidate.id,
          customBuildId: generation.id,
        },
      },
      create: {
        id,
        candidateId: candidate.id,
        customBuildId: generation.id,
        contributorId: userId,
        postAnonymously: input.postAnonymously,
      },
      update: { postAnonymously: input.postAnonymously },
      select: { id: true },
    });
    const created = example.id === id;
    if (created) {
      await tx.galleryCandidate.update({
        where: { id: candidate.id },
        data: { publishedAt: new Date() },
      });
    }
    return { ...example, created };
  });
}

export async function removeGalleryCandidate(userId: string, publicId: string) {
  const candidate = await prisma.galleryCandidate.findFirst({
    where: { publicId, uploaderId: userId, removedAt: null },
    select: { id: true, promptText: true, selectedAt: true, officialPromptId: true },
  });
  if (!candidate) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
  if (candidate.selectedAt || candidate.officialPromptId) {
    throw new GalleryServiceError("selected_candidate", "Selected prompts are managed by MineBench.");
  }
  const now = new Date();
  const purgeAt = new Date(now.getTime() + RETENTION_MS);
  await prisma.$transaction(async (tx) => {
    const removed = await tx.galleryCandidate.updateMany({
      where: {
        id: candidate.id,
        uploaderId: userId,
        removedAt: null,
        selectedAt: null,
        officialPromptId: null,
      },
      data: { removedAt: now, purgeAt },
    });
    if (removed.count !== 1) {
      throw new GalleryServiceError("selected_candidate", "Selected prompts are managed by MineBench.");
    }
    await tx.galleryExample.updateMany({
      where: { candidateId: candidate.id, removedAt: null },
      data: { removedAt: now, purgeAt },
    });
    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "CANDIDATE",
        action: "user_removed",
        actorUserId: userId,
        subjectUserId: userId,
        candidateId: candidate.id,
        safeSnapshot: { prompt: candidate.promptText },
        purgeAt,
      },
    });
  });
  return { removed: true };
}

export async function setGalleryVote(input: {
  publicId: string;
  sessionId: string;
  userId: string | null;
  upvoted: boolean;
  blocked?: boolean;
}) {
  const candidate = await prisma.galleryCandidate.findFirst({
    where: { publicId: input.publicId, ...publicCandidateWhere },
    select: { id: true, upvoteCount: true },
  });
  if (!candidate) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
  if (input.blocked) {
    return { upvoted: input.upvoted, count: candidate.upvoteCount };
  }
  return prisma.$transaction(async (tx) => {
    if (input.upvoted) {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "GalleryVote" (id, "candidateId", "sessionId", "userId", "createdAt")
        VALUES (${randomBytes(16).toString("hex")}, ${candidate.id}, ${input.sessionId}, ${input.userId}::uuid, now())
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) {
        await tx.galleryCandidate.update({
          where: { id: candidate.id },
          data: { upvoteCount: { increment: 1 } },
        });
      }
    } else {
      const identity = input.userId
        ? Prisma.sql`"userId" = ${input.userId}::uuid`
        : Prisma.sql`"sessionId" = ${input.sessionId}`;
      const removed = await tx.$queryRaw<Array<{ id: string }>>`
        DELETE FROM "GalleryVote"
        WHERE "candidateId" = ${candidate.id} AND ${identity}
        RETURNING id
      `;
      if (removed.length > 0) {
        await tx.$executeRaw`
          UPDATE "GalleryCandidate"
          SET "upvoteCount" = GREATEST(0, "upvoteCount" - 1), "updatedAt" = now()
          WHERE id = ${candidate.id}
        `;
      }
    }
    const current = await tx.galleryCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { upvoteCount: true },
    });
    const vote = await tx.galleryVote.findFirst({
      where: {
        candidateId: candidate.id,
        OR: [
          { sessionId: input.sessionId },
          ...(input.userId ? [{ userId: input.userId }] : []),
        ],
      },
      select: { id: true },
    });
    return { upvoted: Boolean(vote), count: current.upvoteCount };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function claimAnonymousGalleryVotes(userId: string, sessionId: string | null) {
  if (!sessionId) return 0;
  return prisma.$transaction(async (tx) => {
    const duplicates = await tx.$queryRaw<Array<{ candidateId: string }>>`
      DELETE FROM "GalleryVote" anonymous
      USING "GalleryVote" owned
      WHERE anonymous."sessionId" = ${sessionId}
        AND anonymous."userId" IS NULL
        AND owned."candidateId" = anonymous."candidateId"
        AND owned."userId" = ${userId}::uuid
      RETURNING anonymous."candidateId" AS "candidateId"
    `;
    for (const duplicate of duplicates) {
      await tx.$executeRaw`
        UPDATE "GalleryCandidate"
        SET "upvoteCount" = GREATEST(0, "upvoteCount" - 1), "updatedAt" = now()
        WHERE id = ${duplicate.candidateId}
      `;
    }
    const claimed = await tx.galleryVote.updateMany({
      where: { sessionId, userId: null },
      data: { userId },
    });
    return duplicates.length + claimed.count;
  });
}

export async function requireMineBenchAdmin(userId: string) {
  const admin = await prisma.user.findFirst({
    where: { id: userId, isMineBenchAdmin: true, deletedAt: null },
    select: { id: true },
  });
  if (!admin) throw new GalleryServiceError("forbidden", "MineBench admin access required.");
}

export async function setGalleryCandidateSelected(adminId: string, publicId: string, selected: boolean) {
  await requireMineBenchAdmin(adminId);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "GalleryCandidate"
      WHERE "publicId" = ${publicId}
        AND "removedAt" IS NULL
      FOR UPDATE
    `;
    const candidate = locked[0]
      ? await tx.galleryCandidate.findUnique({
          where: { id: locked[0].id },
          select: {
            id: true,
            promptText: true,
            selectedAt: true,
            officialPromptId: true,
            adminHiddenAt: true,
            uploaderId: true,
            uploader: { select: { email: true } },
          },
        })
      : null;
    if (!candidate || (selected && candidate.adminHiddenAt)) {
      throw new GalleryServiceError("not_found", "Gallery prompt not found.");
    }
    if (Boolean(candidate.selectedAt || candidate.officialPromptId) === selected) {
      return {
        promptId: candidate.officialPromptId,
        promptText: candidate.promptText,
        uploaderId: candidate.uploaderId,
        uploaderEmail: candidate.uploader.email,
        transitioned: false,
      };
    }
    const prompt = selected
      ? await tx.prompt.upsert({
          where: { text: candidate.promptText },
          create: { text: candidate.promptText, active: false },
          update: {},
          select: { id: true },
        })
      : null;
    const transition = await tx.galleryCandidate.updateMany({
      where: selected
        ? { id: candidate.id, selectedAt: null, removedAt: null, adminHiddenAt: null }
        : {
            id: candidate.id,
            OR: [{ selectedAt: { not: null } }, { officialPromptId: { not: null } }],
          },
      data: selected
        ? { selectedAt: now, selectedById: adminId, officialPromptId: prompt!.id }
        : { selectedAt: null, selectedById: null, officialPromptId: null },
    });
    if (transition.count !== 1) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "CANDIDATE",
        action: selected ? "selected" : "unselected",
        actorUserId: adminId,
        subjectUserId: candidate.uploaderId,
        candidateId: candidate.id,
        safeSnapshot: { prompt: candidate.promptText },
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    });
    return {
      promptId: prompt?.id ?? null,
      promptText: candidate.promptText,
      uploaderId: candidate.uploaderId,
      uploaderEmail: candidate.uploader.email,
      transitioned: true,
    };
  });
  if (selected && result.transitioned && result.uploaderId !== adminId) {
    await deliverGalleryEmail(
      sendGalleryAccountNotification(result.uploaderEmail, {
        heading: "Your prompt was selected",
        intro: "MineBench selected your Gallery prompt for the benchmark collection.",
        details: { Prompt: result.promptText },
      }),
      "candidate_selected",
    );
  }
  return { selected, promptId: result.promptId };
}

export async function setGalleryPublishingSuspension(
  adminId: string,
  userId: string,
  input: { suspended: boolean; reason?: string },
) {
  await requireMineBenchAdmin(adminId);
  const now = new Date();
  const reason = input.reason?.trim().slice(0, 240) || null;
  const account = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE
    `;
    const account = locked[0]
      ? await tx.user.findUnique({
          where: { id: locked[0].id },
          select: { id: true, email: true, gallerySuspendedAt: true },
        })
      : null;
    if (!account) throw new GalleryServiceError("not_found", "Account not found.");
    if (Boolean(account.gallerySuspendedAt) === input.suspended) {
      return { ...account, changed: false };
    }
    await tx.user.update({
      where: { id: userId },
      data: input.suspended
        ? {
            gallerySuspendedAt: now,
            gallerySuspensionReason: reason,
            gallerySuspendedById: adminId,
          }
        : {
            gallerySuspendedAt: null,
            gallerySuspensionReason: null,
            gallerySuspendedById: null,
            galleryRestoredAt: now,
          },
    });
    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "ACCOUNT",
        action: input.suspended ? "suspended" : "restored",
        actorUserId: adminId,
        subjectUserId: userId,
        note: reason,
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    });
    return { ...account, changed: true };
  });
  if (account.changed) {
    await deliverGalleryEmail(
      sendGalleryAccountNotification(account.email, input.suspended
        ? {
            heading: "Account suspended",
            intro: "Gallery publishing has been suspended for this account. You can appeal from Account settings.",
            details: { Reason: reason },
            action: { label: "Appeal", href: galleryUrl("/account") },
          }
        : {
            heading: "Gallery publishing restored",
            intro: "Gallery publishing has been restored for this account.",
          }),
      input.suspended ? "account_suspended" : "account_restored",
    );
  }
  return { suspended: input.suspended, changed: account.changed };
}

export async function setHostedGenerationLimit(
  adminId: string,
  userId: string,
  limit: number,
) {
  await requireMineBenchAdmin(adminId);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_HOSTED_GENERATION_LIMIT) {
    throw new GalleryServiceError("invalid_request", "Enter a valid hosted generation limit.");
  }
  try {
    return await prisma.user.update({
      where: { id: userId },
      data: { hostedGenerationLimit: limit },
      select: { hostedGenerationCount: true, hostedGenerationLimit: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new GalleryServiceError("not_found", "Account not found.");
    }
    throw error;
  }
}

export async function updateGalleryNickname(userId: string, draft: string) {
  const value = normalizeGalleryNickname(draft);
  if (!value.display) {
    await prisma.user.update({
      where: { id: userId },
      data: { publicNickname: null, publicNicknameNormalized: null },
    });
    return { publicNickname: null };
  }
  if (value.display.length < 2 || value.display.length > 40 || /[\p{Cc}\p{Cf}]/u.test(value.display)) {
    throw new GalleryServiceError("invalid_nickname", "Use 2–40 visible characters.");
  }
  if (publicGalleryTextError(value.display)) {
    await recordFilterRejection({ userId, target: "ACCOUNT", content: value.display });
    throw new GalleryServiceError("nickname_rejected", "Choose a different public nickname.");
  }
  try {
    const account = await prisma.user.update({
      where: { id: userId },
      data: {
        publicNickname: value.display,
        publicNicknameNormalized: value.normalized,
      },
      select: { publicNickname: true },
    });
    return account;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new GalleryServiceError("nickname_taken", "That nickname is already in use.");
    }
    throw error;
  }
}

export async function submitGalleryAppeal(userId: string, explanation: string) {
  const note = explanation.trim();
  if (!note || note.length > 2000) {
    throw new GalleryServiceError("invalid_appeal", "Explain why the suspension should be reviewed.");
  }
  const account = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE
    `;
    const account = locked[0]
      ? await tx.user.findUnique({
          where: { id: locked[0].id },
          select: {
            email: true,
            publicNickname: true,
            gallerySuspendedAt: true,
            gallerySuspensionReason: true,
            galleryRestoredAt: true,
          },
        })
      : null;
    if (!account?.gallerySuspendedAt) {
      throw new GalleryServiceError("not_suspended", "This account is not suspended.");
    }
    const now = new Date();
    const recent = await tx.galleryModerationRecord.findFirst({
      where: {
        kind: "APPEAL",
        subjectUserId: userId,
        createdAt: {
          gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          ...(account.galleryRestoredAt ? { gt: account.galleryRestoredAt } : {}),
        },
      },
      select: { id: true },
    });
    if (recent) throw new GalleryServiceError("appeal_rate_limited", "An appeal was already submitted in the last 24 hours.");
    await tx.galleryModerationRecord.create({
      data: {
        kind: "APPEAL",
        target: "ACCOUNT",
        actorUserId: userId,
        subjectUserId: userId,
        note,
        safeSnapshot: {
          suspendedAt: account.gallerySuspendedAt.toISOString(),
          reason: account.gallerySuspensionReason,
        },
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    });
    return account;
  });
  await deliverGalleryEmail(
    sendGalleryAdminNotification({
      heading: "Gallery suspension appeal",
      intro: "An account requested a review of its Gallery publishing suspension.",
      details: {
        Account: account.email,
        Nickname: account.publicNickname,
        Explanation: note,
        Reason: account.gallerySuspensionReason,
      },
    }),
    "suspension_appeal",
  );
  return { submitted: true };
}

export async function submitGalleryReport(input: {
  candidatePublicId?: string;
  exampleId?: string;
  reason: "OFFENSIVE" | "SPAM" | "MISLEADING" | "OTHER";
  note?: string;
  actorUserId?: string | null;
  sessionHash?: string | null;
  ipHmac?: string | null;
}) {
  const note = input.note?.trim().slice(0, 1000) || null;
  const candidate = input.candidatePublicId
    ? await prisma.galleryCandidate.findFirst({
        where: { publicId: input.candidatePublicId, ...publicCandidateWhere },
        select: { id: true, promptText: true, uploaderId: true },
      })
    : null;
  const example = input.exampleId
    ? await prisma.galleryExample.findFirst({
        where: {
          id: input.exampleId,
          ...publicExampleWhere,
          candidate: publicCandidateWhere,
        },
        select: {
          id: true,
          candidateId: true,
          contributorId: true,
          candidate: { select: { promptText: true } },
          customBuild: { select: { modelKind: true, modelId: true, modelDisplayName: true } },
        },
      })
    : null;
  if ((!candidate && !example) || Boolean(candidate) === Boolean(example)) {
    throw new GalleryServiceError("not_found", "Gallery contribution not found.");
  }
  const prompt = candidate?.promptText ?? example!.candidate.promptText;
  const model = example
    ? resolveGalleryModelLabel({
        kind: example.customBuild.modelKind === "custom"
          ? "custom"
          : example.customBuild.modelKind === "openrouter"
            ? "openrouter"
            : "catalog",
        displayName: example.customBuild.modelDisplayName,
        modelId: example.customBuild.modelId,
      })
    : null;
  const now = new Date();
  await prisma.galleryModerationRecord.create({
    data: {
      kind: "REPORT",
      target: candidate ? "CANDIDATE" : "EXAMPLE",
      reportReason: input.reason,
      note,
      actorUserId: input.actorUserId,
      subjectUserId: candidate?.uploaderId ?? example?.contributorId,
      candidateId: candidate?.id ?? example?.candidateId,
      exampleId: example?.id,
      sessionHash: input.sessionHash,
      ipHmac: input.ipHmac,
      safeSnapshot: { prompt, model },
      purgeAt: new Date(now.getTime() + RETENTION_MS),
    },
  });
  await deliverGalleryEmail(
    sendGalleryAdminNotification({
      heading: "Gallery report",
      intro: "A public Gallery contribution was reported.",
      details: {
        Type: candidate ? "Candidate" : "Example",
        Reason: input.reason,
        Prompt: prompt,
        Model: model,
        Note: note,
      },
    }),
    "report",
  );
  return { submitted: true };
}

export async function getPublicGalleryExampleArtifact(
  exampleId: string,
  kinds: Array<"preview_svg" | "preview_mbv4" | "viewer_mbv4" | "viewer_mbf1">,
) {
  return prisma.customBuildArtifact.findFirst({
    where: {
      kind: { in: kinds },
      customBuild: {
        removedAt: null,
        status: "succeeded",
        galleryExamples: {
          some: {
            id: exampleId,
            ...publicExampleWhere,
            candidate: publicCandidateWhere,
          },
        },
      },
    },
    select: {
      kind: true,
      bucket: true,
      path: true,
      contentType: true,
      encoding: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function listPublicGalleryExplorerBuilds() {
  const examples = await prisma.galleryExample.findMany({
    where: {
      AND: [
        publicExampleWhere,
        {
          candidate: publicCandidateWhere,
          customBuild: {
            blockCount: { gt: 0 },
            artifacts: { some: { kind: { in: ["viewer_mbf1", "viewer_mbv4"] } } },
          },
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      candidate: { select: { promptText: true } },
      customBuild: {
        select: {
          blockCount: true,
          ...galleryModelSelect,
        },
      },
    },
  });

  return examples.map((example) => ({
    id: example.id,
    model: publicGalleryModel(example.customBuild).label,
    prompt: example.candidate.promptText,
    blockCount: example.customBuild.blockCount ?? 0,
  }));
}

export async function setGalleryCandidateHidden(
  adminId: string,
  publicId: string,
  hidden: boolean,
) {
  await requireMineBenchAdmin(adminId);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "GalleryCandidate"
      WHERE "publicId" = ${publicId}
        AND "removedAt" IS NULL
      FOR UPDATE
    `;
    const candidate = locked[0]
      ? await tx.galleryCandidate.findUnique({
          where: { id: locked[0].id },
          select: { id: true, promptText: true, uploaderId: true, adminHiddenAt: true },
        })
      : null;
    if (!candidate) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
    if (Boolean(candidate.adminHiddenAt) === hidden) return { hidden, changed: false };

    await tx.galleryCandidate.update({
      where: { id: candidate.id },
      data: hidden
        ? { adminHiddenAt: now, purgeAt: new Date(now.getTime() + RETENTION_MS) }
        : { adminHiddenAt: null, purgeAt: null },
    });
    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "CANDIDATE",
        action: hidden ? "admin_hidden" : "admin_restored",
        actorUserId: adminId,
        subjectUserId: candidate.uploaderId,
        candidateId: candidate.id,
        safeSnapshot: { prompt: candidate.promptText },
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    });
    return { hidden, changed: true };
  });
}

export async function hideGalleryCandidate(adminId: string, publicId: string) {
  return setGalleryCandidateHidden(adminId, publicId, true);
}

export async function hideGalleryExample(
  adminId: string,
  exampleId: string,
  deleteArtifact: typeof deleteCustomBuildArtifact = deleteCustomBuildArtifact,
) {
  await requireMineBenchAdmin(adminId);
  const example = await prisma.galleryExample.findFirst({
    where: { id: exampleId, removedAt: null, adminHiddenAt: null },
    select: {
      id: true,
      candidateId: true,
      contributorId: true,
      customBuildId: true,
      candidate: { select: { promptText: true } },
      customBuild: {
        select: {
          artifacts: {
            where: { kind: { not: "preview_svg" } },
            select: { id: true, bucket: true, path: true, storedByteSize: true },
          },
        },
      },
    },
  });
  if (!example) throw new GalleryServiceError("not_found", "Gallery example not found.");
  const now = new Date();
  const purgeAt = new Date(now.getTime() + RETENTION_MS);
  await prisma.$transaction([
    prisma.galleryExample.update({
      where: { id: example.id },
      data: { adminHiddenAt: now, purgeAt, previewRetained: true },
    }),
    prisma.customBuild.update({
      where: { id: example.customBuildId },
      data: { removedAt: now, purgeAt, deletionPendingAt: now },
    }),
    prisma.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "EXAMPLE",
        action: "admin_hidden",
        actorUserId: adminId,
        subjectUserId: example.contributorId,
        candidateId: example.candidateId,
        exampleId: example.id,
        safeSnapshot: { prompt: example.candidate.promptText },
        purgeAt,
      },
    }),
  ]);
  try {
    for (const artifact of example.customBuild.artifacts) {
      await deleteArtifact({ bucket: artifact.bucket, path: artifact.path });
    }
    const removedIds = example.customBuild.artifacts.map((artifact) => artifact.id);
    const retained = await prisma.customBuildArtifact.aggregate({
      where: { customBuildId: example.customBuildId, id: { notIn: removedIds } },
      _sum: { storedByteSize: true },
    });
    await prisma.$transaction([
      prisma.customBuildArtifact.deleteMany({ where: { id: { in: removedIds } } }),
      prisma.customBuild.update({
        where: { id: example.customBuildId },
        data: {
          storedByteSize: retained._sum.storedByteSize ?? 0,
          objectsDeletedAt: now,
          deletionPendingAt: null,
          deletionError: null,
        },
      }),
    ]);
  } catch (error) {
    await prisma.customBuild.update({
      where: { id: example.customBuildId },
      data: { deletionError: redactSensitiveText(error).slice(0, 500) },
    });
  }
  return { hidden: true };
}

function adminSnapshotField(value: Prisma.JsonValue | null, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = value[key];
  return typeof text === "string" ? text.slice(0, 240) : null;
}

function adminSnapshotText(value: Prisma.JsonValue | null): string | null {
  for (const key of ["prompt", "content", "model", "visitor"]) {
    const text = adminSnapshotField(value, key);
    if (text) return text;
  }
  return null;
}

function adminLocation(value: {
  city: string | null;
  countryRegion: string | null;
  country: string | null;
}): string | null {
  const parts = [value.city, value.countryRegion, value.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function adminGuestLabel(sessionId: string): string {
  const identity = hashVoteSession(sessionId) ?? sessionId;
  return `Guest ${identity.slice(0, 6).toUpperCase()}`;
}

export async function getGalleryAdminDashboard(
  adminId: string,
  options: { now?: Date } = {},
) {
  await requireMineBenchAdmin(adminId);
  const now = options.now ?? new Date();
  const retainedSince = new Date(now.getTime() - PUBLIC_SESSION_RETENTION_MS);
  const onlineSince = now.getTime() - PUBLIC_SESSION_ONLINE_MS;
  const [moderation, prompts, accounts, sessions, voteBlocks, onlineGroups] = await Promise.all([
    prisma.galleryModerationRecord.findMany({
      where: { NOT: { action: "email_delivery_failed" } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        kind: true,
        target: true,
        action: true,
        reportReason: true,
        note: true,
        safeSnapshot: true,
        createdAt: true,
        actor: { select: { email: true, publicNickname: true } },
        subject: { select: { email: true, publicNickname: true } },
        candidate: { select: { promptText: true } },
        example: { select: { id: true, removedAt: true, adminHiddenAt: true } },
      },
    }),
    prisma.galleryCandidate.findMany({
      where: { removedAt: null },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: 200,
      select: {
        publicId: true,
        promptText: true,
        upvoteCount: true,
        publishedAt: true,
        selectedAt: true,
        adminHiddenAt: true,
        uploaderId: true,
        uploader: {
          select: {
            publicNickname: true,
            email: true,
            gallerySuspendedAt: true,
          },
        },
        _count: {
          select: { moderationRecords: { where: { kind: "REPORT" } } },
        },
      },
    }),
    prisma.user.findMany({
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: {
        id: true,
        email: true,
        publicNickname: true,
        lastSeenAt: true,
        gallerySuspendedAt: true,
        totalGenerationCount: true,
        hostedGenerationCount: true,
        hostedGenerationLimit: true,
      },
    }),
    prisma.publicSessionActivity.findMany({
      where: { lastSeenAt: { gte: retainedSince } },
      orderBy: { lastSeenAt: "desc" },
      take: 250,
      select: {
        id: true,
        sessionId: true,
        userId: true,
        lastSeenAt: true,
        city: true,
        countryRegion: true,
        country: true,
        ipHmac: true,
        user: {
          select: {
            email: true,
            publicNickname: true,
            gallerySuspendedAt: true,
            totalGenerationCount: true,
            hostedGenerationCount: true,
            hostedGenerationLimit: true,
          },
        },
      },
    }),
    prisma.galleryVoteBlock.findMany({
      where: { reversedAt: null },
      select: { userId: true, sessionHash: true, ipHmac: true },
    }),
    prisma.publicSessionActivity.groupBy({
      by: ["userId"],
      where: { lastSeenAt: { gte: new Date(onlineSince) } },
      _count: { _all: true },
    }),
  ]);

  const blockedUsers = new Set(voteBlocks.flatMap((block) => block.userId ? [block.userId] : []));
  const blockedSessions = new Set(voteBlocks.flatMap((block) => block.sessionHash ? [block.sessionHash] : []));
  const blockedIps = new Set(voteBlocks.flatMap((block) => block.ipHmac ? [block.ipHmac] : []));
  const people = new Map<string, {
    id: string;
    label: string;
    email: string | null;
    lastSeenAt: string | null;
    location: string | null;
    online: boolean;
    suspended: boolean;
    voteBlocked: boolean;
    totalGenerationCount: number | null;
    hostedGenerationCount: number | null;
    hostedGenerationLimit: number | null;
  }>();

  for (const account of accounts) {
    people.set(`user:${account.id}`, {
      id: `user:${account.id}`,
      label: account.publicNickname ?? account.email,
      email: account.email,
      lastSeenAt: account.lastSeenAt?.toISOString() ?? null,
      location: null,
      online: false,
      suspended: Boolean(account.gallerySuspendedAt),
      voteBlocked: blockedUsers.has(account.id),
      totalGenerationCount: account.totalGenerationCount,
      hostedGenerationCount: account.hostedGenerationCount,
      hostedGenerationLimit: account.hostedGenerationLimit,
    });
  }

  for (const session of sessions) {
    const online = session.lastSeenAt.getTime() >= onlineSince;
    const sessionHash = hashVoteSession(session.sessionId);
    const sessionBlocked = Boolean(
      (sessionHash && blockedSessions.has(sessionHash)) ||
      (session.ipHmac && blockedIps.has(session.ipHmac)),
    );
    if (session.userId && session.user) {
      const id = `user:${session.userId}`;
      const existing = people.get(id);
      const newer = !existing?.lastSeenAt || session.lastSeenAt.getTime() > new Date(existing.lastSeenAt).getTime();
      people.set(id, {
        id,
        label: session.user.publicNickname ?? session.user.email,
        email: session.user.email,
        lastSeenAt: newer ? session.lastSeenAt.toISOString() : existing?.lastSeenAt ?? null,
        location: newer ? adminLocation(session) : existing?.location ?? null,
        online: Boolean(existing?.online || online),
        suspended: Boolean(session.user.gallerySuspendedAt),
        voteBlocked: Boolean(existing?.voteBlocked || blockedUsers.has(session.userId) || sessionBlocked),
        totalGenerationCount: session.user.totalGenerationCount,
        hostedGenerationCount: session.user.hostedGenerationCount,
        hostedGenerationLimit: session.user.hostedGenerationLimit,
      });
      continue;
    }
    people.set(`session:${session.id}`, {
      id: `session:${session.id}`,
      label: adminGuestLabel(session.sessionId),
      email: null,
      lastSeenAt: session.lastSeenAt.toISOString(),
      location: adminLocation(session),
      online,
      suspended: false,
      voteBlocked: sessionBlocked,
      totalGenerationCount: null,
      hostedGenerationCount: null,
      hostedGenerationLimit: null,
    });
  }

  return {
    refreshedAt: now.toISOString(),
    onlinePeopleCount: onlineGroups.reduce((total, group) => total + (group.userId ? 1 : group._count._all), 0),
    prompts: prompts.map((prompt) => ({
      publicId: prompt.publicId,
      prompt: prompt.promptText,
      upvoteCount: prompt.upvoteCount,
      publishedAt: prompt.publishedAt.toISOString(),
      selected: Boolean(prompt.selectedAt),
      hidden: Boolean(prompt.adminHiddenAt),
      reportCount: prompt._count.moderationRecords,
      uploader: {
        id: prompt.uploaderId,
        email: prompt.uploader.email,
        publicNickname: prompt.uploader.publicNickname,
        suspended: Boolean(prompt.uploader.gallerySuspendedAt),
      },
    })),
    people: [...people.values()].sort((a, b) =>
      Number(b.online) - Number(a.online)
      || (b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0)
        - (a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0)
      || a.label.localeCompare(b.label)
    ),
    activity: moderation.map((record) => ({
      id: record.id,
      kind: record.kind,
      target: record.target,
      action: record.action,
      reason: record.reportReason,
      note: record.note,
      summary: record.candidate?.promptText
        ?? adminSnapshotText(record.safeSnapshot)
        ?? record.action
        ?? record.reportReason
        ?? record.target,
      actor: record.actor?.publicNickname ?? record.actor?.email ?? null,
      subject: record.subject?.publicNickname ?? record.subject?.email ?? null,
      detail: record.target === "EXAMPLE" ? adminSnapshotField(record.safeSnapshot, "model") : null,
      exampleId: record.kind === "REPORT" && record.target === "EXAMPLE"
        && record.example && !record.example.removedAt && !record.example.adminHiddenAt
        ? record.example.id
        : null,
      createdAt: record.createdAt.toISOString(),
    })),
  };
}

async function resolveGalleryAdminPerson(personId: string) {
  if (personId.startsWith("user:")) {
    const userId = personId.slice(5);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        publicNickname: true,
        lastSeenAt: true,
        gallerySuspendedAt: true,
        gallerySuspensionReason: true,
        totalGenerationCount: true,
        hostedGenerationCount: true,
        hostedGenerationLimit: true,
        publicSessionActivities: {
          orderBy: { lastSeenAt: "desc" },
          take: 50,
          select: {
            sessionId: true,
            lastSeenAt: true,
            city: true,
            countryRegion: true,
            country: true,
            ipHmac: true,
          },
        },
      },
    });
    if (!user) throw new GalleryServiceError("not_found", "Person not found.");
    const latest = user.publicSessionActivities[0];
    return {
      id: personId,
      userId: user.id,
      sessionIds: user.publicSessionActivities.map((session) => session.sessionId),
      ipHmacs: Array.from(new Set(user.publicSessionActivities.flatMap((session) =>
        session.ipHmac ? [session.ipHmac] : []
      ))),
      label: user.publicNickname ?? user.email,
      email: user.email,
      lastSeenAt: latest?.lastSeenAt ?? user.lastSeenAt,
      location: latest ? adminLocation(latest) : null,
      suspendedAt: user.gallerySuspendedAt,
      suspensionReason: user.gallerySuspensionReason,
      totalGenerationCount: user.totalGenerationCount,
      hostedGenerationCount: user.hostedGenerationCount,
      hostedGenerationLimit: user.hostedGenerationLimit,
    };
  }

  if (personId.startsWith("session:")) {
    const session = await prisma.publicSessionActivity.findUnique({
      where: { id: personId.slice(8) },
      select: {
        sessionId: true,
        lastSeenAt: true,
        city: true,
        countryRegion: true,
        country: true,
        ipHmac: true,
      },
    });
    if (!session) throw new GalleryServiceError("not_found", "Person not found.");
    return {
      id: personId,
      userId: null,
      sessionIds: [session.sessionId],
      ipHmacs: session.ipHmac ? [session.ipHmac] : [],
      label: adminGuestLabel(session.sessionId),
      email: null,
      lastSeenAt: session.lastSeenAt,
      location: adminLocation(session),
      suspendedAt: null,
      suspensionReason: null,
      totalGenerationCount: null,
      hostedGenerationCount: null,
      hostedGenerationLimit: null,
    };
  }

  throw new GalleryServiceError("not_found", "Person not found.");
}

function adminArenaChoice(
  choice: string,
  modelA: string,
  modelB: string,
): string {
  if (choice === "A") return modelA;
  if (choice === "B") return modelB;
  return choice.toLowerCase().replaceAll("_", " ");
}

export async function getGalleryAdminPerson(adminId: string, personId: string) {
  await requireMineBenchAdmin(adminId);
  const person = await resolveGalleryAdminPerson(personId);
  const voteIdentities = [
    person.userId ? { userId: person.userId } : null,
    person.sessionIds.length > 0 ? { sessionId: { in: person.sessionIds } } : null,
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  const sessionHashes = person.sessionIds.map(hashVoteSession).filter((value): value is string => Boolean(value));
  const blockIdentities = [
    person.userId ? { userId: person.userId } : null,
    ...sessionHashes.map((sessionHash) => ({ sessionHash })),
    ...person.ipHmacs.map((ipHmac) => ({ ipHmac })),
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  const [arenaVotes, galleryVotes, contributions, voteBlocked] = await Promise.all([
    voteIdentities.length > 0
      ? prisma.vote.findMany({
          where: { OR: voteIdentities, matchup: { stealthVariantId: null } },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: {
            id: true,
            choice: true,
            createdAt: true,
            matchup: {
              select: {
                prompt: { select: { text: true } },
                modelA: { select: { displayName: true } },
                modelB: { select: { displayName: true } },
              },
            },
          },
        })
      : [],
    voteIdentities.length > 0
      ? prisma.galleryVote.findMany({
          where: { OR: voteIdentities },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: {
            id: true,
            createdAt: true,
            candidate: { select: { publicId: true, promptText: true } },
          },
        })
      : [],
    person.userId
      ? prisma.galleryCandidate.findMany({
          where: { uploaderId: person.userId },
          orderBy: { publishedAt: "desc" },
          take: 25,
          select: {
            publicId: true,
            promptText: true,
            publishedAt: true,
            selectedAt: true,
            removedAt: true,
            adminHiddenAt: true,
          },
        })
      : [],
    blockIdentities.length > 0
      ? prisma.galleryVoteBlock.findFirst({
          where: { reversedAt: null, OR: blockIdentities },
          select: { id: true },
        })
      : null,
  ]);

  const votes = [
    ...arenaVotes.map((vote) => ({
      id: `arena:${vote.id}`,
      source: "Arena" as const,
      prompt: vote.matchup.prompt.text,
      result: adminArenaChoice(
        vote.choice,
        vote.matchup.modelA.displayName,
        vote.matchup.modelB.displayName,
      ),
      modelA: vote.matchup.modelA.displayName,
      modelB: vote.matchup.modelB.displayName,
      choice: vote.choice,
      href: null,
      createdAt: vote.createdAt.toISOString(),
    })),
    ...galleryVotes.map((vote) => ({
      id: `gallery:${vote.id}`,
      source: "Gallery" as const,
      prompt: vote.candidate.promptText,
      result: "Upvoted",
      modelA: null,
      modelB: null,
      choice: "UPVOTE" as const,
      href: `/gallery/${vote.candidate.publicId}`,
      createdAt: vote.createdAt.toISOString(),
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 100);

  return {
    id: person.id,
    userId: person.userId,
    label: person.label,
    email: person.email,
    lastSeenAt: person.lastSeenAt?.toISOString() ?? null,
    location: person.location,
    online: Boolean(person.lastSeenAt && person.lastSeenAt.getTime() >= Date.now() - PUBLIC_SESSION_ONLINE_MS),
    suspended: Boolean(person.suspendedAt),
    suspensionReason: person.suspensionReason,
    totalGenerationCount: person.totalGenerationCount,
    hostedGenerationCount: person.hostedGenerationCount,
    hostedGenerationLimit: person.hostedGenerationLimit,
    voteBlocked: Boolean(voteBlocked),
    contributions: contributions.map((candidate) => ({
      publicId: candidate.publicId,
      prompt: candidate.promptText,
      publishedAt: candidate.publishedAt.toISOString(),
      status: candidate.removedAt
        ? "Removed"
        : candidate.adminHiddenAt
          ? "Hidden"
          : candidate.selectedAt
            ? "Selected"
            : "Live",
    })),
    votes,
  };
}

export async function setGalleryPersonVoteBlocked(
  adminId: string,
  personId: string,
  blocked: boolean,
) {
  await requireMineBenchAdmin(adminId);
  const person = await resolveGalleryAdminPerson(personId);
  const sessionHashes = person.sessionIds.map(hashVoteSession).filter((value): value is string => Boolean(value));
  const sessionHash = sessionHashes[0] ?? null;
  const ipHmac = person.ipHmacs[0] ?? null;
  const identities = [
    person.userId ? { userId: person.userId } : null,
    ...sessionHashes.map((value) => ({ sessionHash: value })),
    ...person.ipHmacs.map((value) => ({ ipHmac: value })),
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (identities.length === 0) throw new GalleryServiceError("not_found", "Person not found.");
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    if (person.userId) {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${person.userId}::uuid FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT id FROM "PublicSessionActivity" WHERE id = ${personId.slice(8)} FOR UPDATE`;
    }
    let changed = false;
    if (blocked) {
      const active = await tx.galleryVoteBlock.findMany({
        where: { reversedAt: null, OR: identities },
        select: { userId: true, sessionHash: true, ipHmac: true },
      });
      const activeKeys = new Set(active.flatMap((entry) => [
        entry.userId ? `user:${entry.userId}` : null,
        entry.sessionHash ? `session:${entry.sessionHash}` : null,
        entry.ipHmac ? `ip:${entry.ipHmac}` : null,
      ].filter((value): value is string => Boolean(value))));
      const rows = [
        person.userId && !activeKeys.has(`user:${person.userId}`) ? { userId: person.userId } : null,
        ...sessionHashes.map((value) => activeKeys.has(`session:${value}`) ? null : { sessionHash: value }),
        ...person.ipHmacs.map((value) => activeKeys.has(`ip:${value}`) ? null : { ipHmac: value }),
      ].filter((value): value is NonNullable<typeof value> => Boolean(value));
      if (rows.length === 0) return { blocked, changed: false };
      await tx.galleryVoteBlock.createMany({
        data: rows.map((identity) => ({ ...identity, createdById: adminId })),
      });
      changed = true;
    } else {
      const reversed = await tx.galleryVoteBlock.updateMany({
        where: { reversedAt: null, OR: identities },
        data: { reversedAt: now, reversedById: adminId },
      });
      if (reversed.count === 0) return { blocked, changed: false };
      changed = true;
    }
    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "VOTE_BLOCK",
        action: blocked ? "vote_blocked" : "vote_restored",
        actorUserId: adminId,
        subjectUserId: person.userId,
        sessionHash,
        ipHmac,
        safeSnapshot: person.userId ? undefined : { visitor: person.label },
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    });
    return { blocked, changed };
  });
}
