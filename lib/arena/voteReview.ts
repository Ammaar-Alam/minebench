import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createVoteBlock, hashVoteSession, reverseVoteBlock } from "@/lib/voteBlock";
import { GalleryServiceError, requireMineBenchAdmin, setGalleryPersonVoteBlocked } from "@/lib/gallery/service";
import { PUBLIC_SESSION_RETENTION_MS } from "@/lib/publicPresence";

const SESSION_LIMIT = 1000;
const PAGE_SIZE = 100;

export type VoteReviewSession = {
  sessionId: string;
  label: string;
  location: string | null;
  lastVoteAt: string | null;
  votes: number;
  choiceA: number;
  choiceB: number;
  ties: number;
  bothBad: number;
  medianGapSeconds: number | null;
  fastVotes: number;
  repeatVotes: number;
  rankedVotes: number;
  upsets: number;
  largeUpsets: number;
  flags: string[];
  blocked: boolean;
  networkLabel: string | null;
  matchingSessions: number;
};
export type VoteReviewData = {
  sessions: VoteReviewSession[];
  since: string;
  until: string;
  rankingAt: string | null;
  truncated: boolean;
};
export type VoteReviewCursor = { id: string; createdAt: string };
export type VoteReviewPage = {
  votes: Array<{
    id: string;
    createdAt: string;
    prompt: string;
    modelA: string;
    modelB: string;
    rankA: number | null;
    rankB: number | null;
    choice: string;
  }>;
  nextCursor: VoteReviewCursor | null;
};

type Metrics = Pick<VoteReviewSession, "votes" | "choiceA" | "choiceB" | "bothBad" | "fastVotes" | "repeatVotes" | "rankedVotes" | "upsets" | "largeUpsets">;

export function voteReviewFlags(row: Metrics): string[] {
  const flags: string[] = [];
  const decisive = row.choiceA + row.choiceB;
  if (row.votes >= 20 && row.fastVotes >= (row.votes - 1) / 2) flags.push("Rapid voting");
  if (decisive >= 20 && Math.max(row.choiceA, row.choiceB) / decisive >= 0.9) flags.push("One-sided voting");
  if (row.rankedVotes >= 10 && row.upsets / row.rankedVotes >= 0.8) flags.push("Repeated ranking upsets");
  if (row.rankedVotes >= 10 && row.largeUpsets >= 3) flags.push("Large ranking upsets");
  if (row.votes >= 20 && row.bothBad >= 10 && row.bothBad / row.votes >= 0.4) flags.push("Frequent rejections");
  if (row.votes >= 20 && row.repeatVotes / row.votes >= 0.5) flags.push("Repeated matchups");
  return flags;
}

function checkSession(sessionId: string) {
  if (!sessionId || sessionId.length > 191) throw new GalleryServiceError("invalid", "Invalid session.");
}

async function latestRanks() {
  const latest = await prisma.modelRankSnapshot.findFirst({
    where: { capturedAt: { lte: new Date() } }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true },
  });
  const ranks = latest ? await prisma.modelRankSnapshot.findMany({
    where: { capturedAt: latest.capturedAt }, select: { modelId: true, rank: true },
  }) : [];
  return { capturedAt: latest?.capturedAt ?? null, ranks: new Map(ranks.map(row => [row.modelId, row.rank])) };
}

export async function getArenaVoteReview(adminId: string): Promise<VoteReviewData> {
  await requireMineBenchAdmin(adminId);
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const retainedSince = new Date(now.getTime() - PUBLIC_SESSION_RETENTION_MS);
  const ranking = await latestRanks();
  type Summary = Metrics & { sessionId: string; userId: string | null; lastVoteAt: Date | null; ties: number; medianGapSeconds: number | null };
  const [rows, blocks] = await Promise.all([
    prisma.$queryRaw<Summary[]>(Prisma.sql`
      WITH ranks AS (
        SELECT "modelId", rank FROM "ModelRankSnapshot" WHERE "capturedAt" = (${ranking.capturedAt}::timestamptz AT TIME ZONE 'UTC')
      ), votes AS (
        SELECT v.*, m."buildAId", m."buildBId", a.rank AS rank_a, b.rank AS rank_b,
          EXTRACT(EPOCH FROM v."createdAt" - LAG(v."createdAt") OVER (
            PARTITION BY v."sessionId" ORDER BY v."createdAt", v.id
          ))::double precision AS gap
        FROM "Vote" v JOIN "Matchup" m ON m.id = v."matchupId"
        LEFT JOIN ranks a ON a."modelId" = m."modelAId"
        LEFT JOIN ranks b ON b."modelId" = m."modelBId"
        WHERE v."createdAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
          AND v."createdAt" <= (${now}::timestamptz AT TIME ZONE 'UTC') AND m."stealthVariantId" IS NULL
      )
      SELECT "sessionId", MAX("userId"::text) AS "userId", MAX("createdAt") AS "lastVoteAt",
        COUNT(*)::int AS votes,
        COUNT(*) FILTER (WHERE choice = 'A')::int AS "choiceA",
        COUNT(*) FILTER (WHERE choice = 'B')::int AS "choiceB",
        COUNT(*) FILTER (WHERE choice = 'TIE')::int AS ties,
        COUNT(*) FILTER (WHERE choice = 'BOTH_BAD')::int AS "bothBad",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap) AS "medianGapSeconds",
        COUNT(*) FILTER (WHERE gap < 2)::int AS "fastVotes",
        (COUNT(*) - COUNT(DISTINCT (LEAST("buildAId", "buildBId"), GREATEST("buildAId", "buildBId"))))::int AS "repeatVotes",
        COUNT(*) FILTER (WHERE choice IN ('A', 'B') AND rank_a IS NOT NULL AND rank_b IS NOT NULL)::int AS "rankedVotes",
        COUNT(*) FILTER (WHERE (choice = 'A' AND rank_a > rank_b) OR (choice = 'B' AND rank_b > rank_a))::int AS upsets,
        COUNT(*) FILTER (WHERE
          (choice = 'A' AND rank_b <= ${Math.max(1, Math.floor(ranking.ranks.size * 0.15))} AND rank_a > ${ranking.ranks.size / 2}) OR
          (choice = 'B' AND rank_a <= ${Math.max(1, Math.floor(ranking.ranks.size * 0.15))} AND rank_b > ${ranking.ranks.size / 2})
        )::int AS "largeUpsets"
      FROM votes GROUP BY "sessionId" ORDER BY "lastVoteAt" DESC, "sessionId" LIMIT ${SESSION_LIMIT + 1}
    `),
    prisma.galleryVoteBlock.findMany({ where: { reversedAt: null }, select: { userId: true, sessionHash: true, ipHmac: true } }),
  ]);
  const ipBlocks = blocks.flatMap(block => block.ipHmac ? [block.ipHmac] : []);
  const blockedSessions = new Set(blocks.flatMap(block => block.sessionHash ? [block.sessionHash] : []));
  const blockedUsers = new Set(blocks.flatMap(block => block.userId ? [block.userId] : []));
  // ponytail: scan retained session IDs for hash matches until volume warrants an indexed hash
  const blockedSessionIds = blockedSessions.size ? (await prisma.publicSessionActivity.findMany({
    where: { lastSeenAt: { gte: retainedSince } }, select: { sessionId: true },
  })).filter(session => blockedSessions.has(hashVoteSession(session.sessionId)!)).map(session => session.sessionId) : [];

  const sessions = await prisma.publicSessionActivity.findMany({
    where: { lastSeenAt: { gte: retainedSince }, OR: [
      { sessionId: { in: [...rows.slice(0, SESSION_LIMIT).map(row => row.sessionId), ...blockedSessionIds] } },
      ...(blockedUsers.size ? [{ userId: { in: [...blockedUsers] } }] : []),
      ...(ipBlocks.length ? [{ ipHmac: { in: ipBlocks } }] : []),
    ] },
    orderBy: { lastSeenAt: "desc" }, take: SESSION_LIMIT + 1,
    select: { sessionId: true, userId: true, ipHmac: true, city: true, countryRegion: true, country: true },
  });
  const ips = [...new Set(sessions.flatMap(session => session.ipHmac ? [session.ipHmac] : []))];
  const [networks, accounts] = await Promise.all([
    prisma.publicSessionActivity.groupBy({ by: ["ipHmac"], where: { ipHmac: { in: ips }, lastSeenAt: { gte: retainedSince } }, _count: { _all: true } }),
    prisma.user.findMany({ where: { id: { in: [...rows, ...sessions].flatMap(row => row.userId ? [row.userId] : []) } }, select: { id: true, publicNickname: true, email: true } }),
  ]);
  const presence = new Map(sessions.map(session => [session.sessionId, session]));
  const networkCounts = new Map(networks.map(network => [network.ipHmac, network._count._all]));
  const labels = new Map(accounts.map(account => [account.id, account.publicNickname ?? account.email]));
  const blockedIps = new Set(ipBlocks);
  const summaries = new Map(rows.slice(0, SESSION_LIMIT).map(row => [row.sessionId, row]));
  // keep restricted visitors visible after their votes are removed
  for (const session of sessions) {
    if (!summaries.has(session.sessionId) && (
      blockedSessions.has(hashVoteSession(session.sessionId)!) ||
      Boolean(session.userId && blockedUsers.has(session.userId)) ||
      Boolean(session.ipHmac && blockedIps.has(session.ipHmac))
    )) {
      summaries.set(session.sessionId, { sessionId: session.sessionId, userId: session.userId, lastVoteAt: null,
        votes: 0, choiceA: 0, choiceB: 0, ties: 0, bothBad: 0, medianGapSeconds: null,
        fastVotes: 0, repeatVotes: 0, rankedVotes: 0, upsets: 0, largeUpsets: 0 });
    }
  }
  return {
    since: since.toISOString(), until: now.toISOString(), rankingAt: ranking.capturedAt?.toISOString() ?? null,
    truncated: rows.length > SESSION_LIMIT || sessions.length > SESSION_LIMIT,
    sessions: [...summaries.values()].map(row => {
      const session = presence.get(row.sessionId);
      const sessionHash = hashVoteSession(row.sessionId)!;
      const ip = session?.ipHmac;
      const userId = row.userId ?? session?.userId;
      return { ...row, lastVoteAt: row.lastVoteAt?.toISOString() ?? null,
        label: (userId && labels.get(userId)) || `Guest ${sessionHash.slice(0, 6).toUpperCase()}`,
        location: session ? [session.city, session.countryRegion, session.country].filter(Boolean).join(", ") || null : null,
        networkLabel: ip ? `IP ${ip.slice(0, 8).toUpperCase()}` : null,
        matchingSessions: ip ? networkCounts.get(ip) ?? 0 : 0,
        blocked: blockedSessions.has(sessionHash) || Boolean(ip && blockedIps.has(ip)) || Boolean(userId && blockedUsers.has(userId)),
        flags: voteReviewFlags(row),
      };
    }),
  };
}

export async function getArenaVotePage(adminId: string, sessionId: string, cursor?: VoteReviewCursor): Promise<VoteReviewPage> {
  await requireMineBenchAdmin(adminId);
  checkSession(sessionId);
  if (cursor && (!cursor.id || cursor.id.length > 191 || !Number.isFinite(Date.parse(cursor.createdAt)))) {
    throw new GalleryServiceError("invalid", "Invalid vote cursor.");
  }
  const [votes, ranking] = await Promise.all([
    prisma.vote.findMany({
      where: { sessionId, matchup: { stealthVariantId: null }, ...(cursor ? { OR: [
        { createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
      ] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE_SIZE + 1,
      select: { id: true, createdAt: true, choice: true, matchup: { select: {
        prompt: { select: { text: true } }, modelA: { select: { id: true, displayName: true } }, modelB: { select: { id: true, displayName: true } },
      } } },
    }), latestRanks(),
  ]);
  const page = votes.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    votes: page.map(vote => ({ id: vote.id, createdAt: vote.createdAt.toISOString(), choice: vote.choice,
      prompt: vote.matchup.prompt.text, modelA: vote.matchup.modelA.displayName, modelB: vote.matchup.modelB.displayName,
      rankA: ranking.ranks.get(vote.matchup.modelA.id) ?? null, rankB: ranking.ranks.get(vote.matchup.modelB.id) ?? null })),
    nextCursor: votes.length > PAGE_SIZE && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null,
  };
}

export async function setArenaVoteSessionBlocked(adminId: string, sessionId: string, blocked: boolean) {
  await requireMineBenchAdmin(adminId);
  checkSession(sessionId);
  const vote = await prisma.vote.findFirst({
    where: { sessionId, userId: { not: null }, matchup: { stealthVariantId: null } },
    orderBy: { createdAt: "desc" }, select: { userId: true },
  });
  if (vote?.userId) return setGalleryPersonVoteBlocked(adminId, `user:${vote.userId}`, blocked);
  const presence = await prisma.publicSessionActivity.findUnique({ where: { sessionId }, select: { id: true, userId: true } });
  if (presence) return setGalleryPersonVoteBlocked(adminId, presence.userId ? `user:${presence.userId}` : `session:${presence.id}`, blocked);
  const sessionHash = hashVoteSession(sessionId)!;
  const existing = await prisma.galleryVoteBlock.findMany({ where: { sessionHash, reversedAt: null }, select: { id: true } });
  if (blocked && existing.length === 0) await createVoteBlock(adminId, { sessionId });
  if (!blocked) for (const block of existing) await reverseVoteBlock(adminId, block.id);
  return { blocked };
}
