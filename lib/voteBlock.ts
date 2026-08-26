import { galleryIdentityHmac } from "@/lib/gallery/policy";
import { prisma } from "@/lib/prisma";

function voteBlockSecret(): string {
  const value = [
    process.env.VOTE_BLOCK_HMAC_SECRET,
    process.env.ARENA_MATCHUP_SIGNING_SECRET,
    process.env.ADMIN_TOKEN,
    process.env.NEXTAUTH_SECRET,
  ].find((candidate) => candidate?.trim())?.trim();
  if (value) return value;
  if (process.env.NODE_ENV !== "production") return "minebench-local-vote-block-secret";
  throw new Error("A server signing secret is required for vote blocks");
}

export function trustedClientIp(headers: Headers): string | null {
  const trustedProxy = process.env.VERCEL === "1" || ["1", "true", "yes", "on"].includes(
    process.env.ARENA_TRUST_X_FORWARDED_FOR?.trim().toLowerCase() ?? "",
  );
  if (!trustedProxy) return null;
  const direct = headers.get("x-real-ip") ?? headers.get("cf-connecting-ip") ?? headers.get("x-vercel-forwarded-for");
  return direct?.split(",")[0]?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

export function hashVoteSession(sessionId: string | null): string | null {
  return sessionId ? galleryIdentityHmac(`session:${sessionId}`, voteBlockSecret()) : null;
}

export function hashVoteIp(ip: string | null): string | null {
  return ip ? galleryIdentityHmac(`ip:${ip}`, voteBlockSecret()) : null;
}

export async function isVoteWriteBlocked(input: {
  userId: string | null;
  sessionId: string | null;
  ip: string | null;
}): Promise<boolean> {
  const sessionHash = hashVoteSession(input.sessionId);
  const ipHmac = hashVoteIp(input.ip);
  const identities = [
    input.userId ? { userId: input.userId } : null,
    sessionHash ? { sessionHash } : null,
    ipHmac ? { ipHmac } : null,
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (identities.length === 0) return false;
  return Boolean(await prisma.galleryVoteBlock.findFirst({
    where: { reversedAt: null, OR: identities },
    select: { id: true },
  }));
}

async function requireAdmin(userId: string) {
  const admin = await prisma.user.findFirst({
    where: { id: userId, isMineBenchAdmin: true },
    select: { id: true },
  });
  if (!admin) throw new Error("MineBench admin access required");
}

export async function createVoteBlock(
  adminId: string,
  input: {
    userId?: string | null;
    sessionId?: string | null;
    ip?: string | null;
    internalNote?: string;
  },
) {
  await requireAdmin(adminId);
  const sessionHash = hashVoteSession(input.sessionId ?? null);
  const ipHmac = hashVoteIp(input.ip ?? null);
  if (!input.userId && !sessionHash && !ipHmac) throw new Error("A vote identity is required");
  return prisma.galleryVoteBlock.create({
    data: {
      userId: input.userId,
      sessionHash,
      ipHmac,
      createdById: adminId,
      internalNote: input.internalNote?.trim().slice(0, 1000) || null,
    },
    select: { id: true, createdAt: true },
  });
}

export async function reverseVoteBlock(adminId: string, blockId: string) {
  await requireAdmin(adminId);
  const result = await prisma.galleryVoteBlock.updateMany({
    where: { id: blockId, reversedAt: null },
    data: { reversedAt: new Date(), reversedById: adminId },
  });
  if (result.count !== 1) throw new Error("Vote block not found");
  return { reversed: true };
}

export async function createVoteBlockFromModerationRecord(
  adminId: string,
  recordId: string,
  internalNote?: string,
) {
  await requireAdmin(adminId);
  const record = await prisma.galleryModerationRecord.findUnique({
    where: { id: recordId },
    select: { actorUserId: true, sessionHash: true, ipHmac: true },
  });
  if (!record || (!record.actorUserId && !record.sessionHash && !record.ipHmac)) {
    throw new Error("No vote identity is available for this record");
  }
  return prisma.galleryVoteBlock.create({
    data: {
      userId: record.actorUserId,
      sessionHash: record.sessionHash,
      ipHmac: record.ipHmac,
      createdById: adminId,
      internalNote: internalNote?.trim().slice(0, 1000) || null,
    },
    select: { id: true, createdAt: true },
  });
}
