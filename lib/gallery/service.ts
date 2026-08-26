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
  publicGalleryTextError,
  resolveGalleryModelLabel,
} from "@/lib/gallery/policy";
import { prisma } from "@/lib/prisma";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

const exampleSelect = {
  id: true,
  candidateId: true,
  createdAt: true,
  postAnonymously: true,
  contributor: { select: { publicNickname: true } },
  customBuild: {
    select: {
      publicId: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      buildByteSize: true,
      generationTimeMs: true,
      buildSha256: true,
      modelKind: true,
      modelId: true,
      modelDisplayName: true,
      artifacts: {
        where: { kind: { in: ["preview_svg", "viewer_mbv4", "viewer_mbf1"] } },
        select: { kind: true },
      },
    },
  },
} satisfies Prisma.GalleryExampleSelect;

type CandidateRow = Prisma.GalleryCandidateGetPayload<{ select: typeof candidateSelect }>;
type ExampleRow = Prisma.GalleryExampleGetPayload<{ select: typeof exampleSelect }>;

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

function publicExample(example: ExampleRow) {
  const kinds = new Set(example.customBuild.artifacts.map((artifact) => artifact.kind));
  const kind =
    example.customBuild.modelKind === "openrouter"
      ? "openrouter"
      : example.customBuild.modelKind === "custom"
        ? "custom"
        : "catalog";
  return {
    id: example.id,
    attribution: galleryAttribution({
      postAnonymously: example.postAnonymously,
      publicNickname: example.contributor.publicNickname,
    }),
    createdAt: example.createdAt.toISOString(),
    model: {
      kind,
      label: resolveGalleryModelLabel({
        kind,
        displayName: example.customBuild.modelDisplayName,
        modelId: example.customBuild.modelId,
      }),
    },
    gridSize: example.customBuild.gridSize,
    palette: example.customBuild.palette === "advanced" ? "advanced" as const : "simple" as const,
    blockCount: example.customBuild.blockCount,
    jsonBytes: example.customBuild.buildByteSize,
    generationTimeMs: example.customBuild.generationTimeMs,
    checksum: example.customBuild.buildSha256,
    previewUrl: kinds.has("preview_svg")
      ? `/api/gallery/examples/${example.id}/preview`
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
) {
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
  };
}

export type GalleryCandidatePayload = ReturnType<typeof publicCandidate>;
export type GalleryExamplePayload = ReturnType<typeof publicExample>;

export async function listGalleryCandidates(options: {
  sort: "top" | "new";
  cursor?: string | null;
  limit?: number;
  sessionId?: string | null;
  userId?: string | null;
}) {
  const limit = Math.max(1, Math.min(options.limit ?? 24, 48));
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
      : {
          OR: [
            { publishedAt: { lt: cursor.publishedAt } },
            { publishedAt: cursor.publishedAt, id: { lt: cursor.id } },
          ],
        }
    : {};
  const rows = await prisma.galleryCandidate.findMany({
    where: { AND: [publicCandidateWhere, cursorWhere] },
    select: candidateListSelect,
    orderBy: options.sort === "top"
      ? [{ upvoteCount: "desc" }, { publishedAt: "desc" }, { id: "desc" }]
      : [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const voteIdentities = [
    options.sessionId ? { sessionId: options.sessionId } : null,
    options.userId ? { userId: options.userId } : null,
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  const votes = voteIdentities.length > 0
    ? await prisma.galleryVote.findMany({
        where: { OR: voteIdentities, candidateId: { in: page.map((row) => row.id) } },
        select: { candidateId: true },
      })
    : [];
  const upvoted = new Set(votes.map((vote) => vote.candidateId));
  const last = page.at(-1);
  return {
    items: page.map((candidate) =>
      publicCandidate(
        candidate,
        candidate.examples[0] ?? null,
        candidate._count.examples,
        upvoted.has(candidate.id),
        options.userId,
        candidate.examples[1] ?? null,
      ),
    ),
    nextCursor: rows.length > limit && last
      ? encodeGalleryCursor({
          score: options.sort === "top" ? last.upvoteCount : 0,
          publishedAt: last.publishedAt,
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
  } = {},
) {
  const candidate = await prisma.galleryCandidate.findFirst({
    where: { publicId, ...publicCandidateWhere },
    select: candidateSelect,
  });
  if (!candidate) return null;
  const limit = Math.max(1, Math.min(options.examplesLimit ?? 24, 48));
  const cursor = decodeGalleryCursor(options.examplesCursor);
  const [cover, exampleCount, upvoted] = await Promise.all([
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
  await prisma.galleryModerationRecord.create({
    data: {
      kind: "FILTER_REJECTION",
      target: args.target,
      actorUserId: args.userId,
      subjectUserId: args.userId,
      action: "blocked_language",
      safeSnapshot: { content: args.content },
      purgeAt: new Date(now.getTime() + RETENTION_MS),
    },
  });
  if (recent < 3) {
    await deliverGalleryEmail(
      sendGalleryAdminNotification({
        heading: "Public submission rejected",
        intro: "A Gallery public-text check rejected a contribution.",
        details: { Type: args.target, Content: args.content },
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
  const promptKey = sha256Hex(prompt);
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
  if (!generation || generation.promptText !== candidate.promptText) {
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

async function requireMineBenchAdmin(userId: string) {
  const admin = await prisma.user.findFirst({
    where: { id: userId, isMineBenchAdmin: true },
    select: { id: true },
  });
  if (!admin) throw new GalleryServiceError("forbidden", "MineBench admin access required.");
}

export async function selectGalleryCandidate(adminId: string, publicId: string) {
  await requireMineBenchAdmin(adminId);
  const now = new Date();
  const selected = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "GalleryCandidate"
      WHERE "publicId" = ${publicId}
        AND "removedAt" IS NULL
        AND "adminHiddenAt" IS NULL
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
            uploaderId: true,
            uploader: { select: { email: true } },
          },
        })
      : null;
    if (!candidate) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
    if (candidate.selectedAt) {
      return {
        promptId: candidate.officialPromptId,
        promptText: candidate.promptText,
        uploaderEmail: candidate.uploader.email,
        transitioned: false,
      };
    }
    const prompt = await tx.prompt.upsert({
      where: { text: candidate.promptText },
      create: { text: candidate.promptText, active: false },
      update: {},
      select: { id: true },
    });
    const transition = await tx.galleryCandidate.updateMany({
      where: { id: candidate.id, selectedAt: null },
      data: { selectedAt: now, selectedById: adminId, officialPromptId: prompt.id },
    });
    if (transition.count !== 1) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "CANDIDATE",
        action: "selected",
        actorUserId: adminId,
        subjectUserId: candidate.uploaderId,
        candidateId: candidate.id,
        safeSnapshot: { prompt: candidate.promptText },
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    });
    return {
      promptId: prompt.id,
      promptText: candidate.promptText,
      uploaderEmail: candidate.uploader.email,
      transitioned: true,
    };
  });
  if (selected.transitioned) {
    await deliverGalleryEmail(
      sendGalleryAccountNotification(selected.uploaderEmail, {
        heading: "Your prompt was selected",
        intro: "MineBench selected your Gallery prompt for the benchmark collection.",
        details: { Prompt: selected.promptText },
      }),
      "candidate_selected",
    );
  }
  return { selected: true, promptId: selected.promptId };
}

export async function setGalleryPublishingSuspension(
  adminId: string,
  userId: string,
  input: { suspended: boolean; reason?: string },
) {
  await requireMineBenchAdmin(adminId);
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!account) throw new GalleryServiceError("not_found", "Account not found.");
  const now = new Date();
  const reason = input.reason?.trim().slice(0, 240) || null;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: input.suspended
        ? {
            gallerySuspendedAt: now,
            gallerySuspensionReason: reason,
            gallerySuspendedById: adminId,
            galleryRestoredAt: null,
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
  });
  await deliverGalleryEmail(
    sendGalleryAccountNotification(account.email, input.suspended
      ? {
          heading: "Account suspended",
          intro: "Gallery publishing has been suspended for this account. You can appeal from Account settings.",
          details: { Reason: reason },
        }
      : {
          heading: "Gallery publishing restored",
          intro: "Gallery publishing has been restored for this account.",
        }),
    input.suspended ? "account_suspended" : "account_restored",
  );
  return { suspended: input.suspended };
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
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
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
  kinds: Array<"preview_svg" | "viewer_mbv4" | "viewer_mbf1">,
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

export async function hideGalleryCandidate(adminId: string, publicId: string) {
  await requireMineBenchAdmin(adminId);
  const candidate = await prisma.galleryCandidate.findFirst({
    where: { publicId, removedAt: null },
    select: { id: true, promptText: true, uploaderId: true },
  });
  if (!candidate) throw new GalleryServiceError("not_found", "Gallery prompt not found.");
  const now = new Date();
  await prisma.$transaction([
    prisma.galleryCandidate.update({ where: { id: candidate.id }, data: { adminHiddenAt: now, purgeAt: new Date(now.getTime() + RETENTION_MS) } }),
    prisma.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "CANDIDATE",
        action: "admin_hidden",
        actorUserId: adminId,
        subjectUserId: candidate.uploaderId,
        candidateId: candidate.id,
        safeSnapshot: { prompt: candidate.promptText },
        purgeAt: new Date(now.getTime() + RETENTION_MS),
      },
    }),
  ]);
  return { hidden: true };
}

export async function hideGalleryExample(
  adminId: string,
  exampleId: string,
  deleteArtifact: typeof deleteCustomBuildArtifact = deleteCustomBuildArtifact,
) {
  await requireMineBenchAdmin(adminId);
  const example = await prisma.galleryExample.findFirst({
    where: { id: exampleId, removedAt: null },
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

export async function getGalleryAdminDashboard(adminId: string) {
  await requireMineBenchAdmin(adminId);
  const [moderation, candidates, suspendedAccounts, voteBlocks] = await Promise.all([
    prisma.galleryModerationRecord.findMany({
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
        actorUserId: true,
        sessionHash: true,
        ipHmac: true,
        subjectUserId: true,
        candidate: { select: { publicId: true } },
        exampleId: true,
        createdAt: true,
      },
    }),
    prisma.galleryCandidate.findMany({
      where: { removedAt: null, adminHiddenAt: null },
      orderBy: [{ selectedAt: "asc" }, { upvoteCount: "desc" }, { publishedAt: "desc" }],
      take: 100,
      select: {
        publicId: true,
        promptText: true,
        upvoteCount: true,
        selectedAt: true,
        uploaderId: true,
        uploader: { select: { publicNickname: true, email: true, gallerySuspendedAt: true } },
      },
    }),
    prisma.user.findMany({
      where: { gallerySuspendedAt: { not: null } },
      orderBy: { gallerySuspendedAt: "desc" },
      take: 100,
      select: {
        id: true,
        email: true,
        publicNickname: true,
        gallerySuspendedAt: true,
        gallerySuspensionReason: true,
      },
    }),
    prisma.galleryVoteBlock.findMany({
      where: { reversedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, userId: true, internalNote: true, createdAt: true },
    }),
  ]);
  return { moderation, candidates, suspendedAccounts, voteBlocks };
}
