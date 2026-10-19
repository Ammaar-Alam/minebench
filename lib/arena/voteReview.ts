import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createVoteBlock, hashVoteSession, reverseVoteBlock } from "@/lib/voteBlock";
import { GalleryServiceError, requireMineBenchAdmin, setGalleryPersonVoteBlocked } from "@/lib/gallery/service";
import { PUBLIC_SESSION_RETENTION_MS } from "@/lib/publicPresence";

const SESSION_LIMIT = 1000;
const PAGE_SIZE = 100;
const VOTE_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
// same cutoffs as the judge's voter review; two people typically agree about 75% of the time
const MIN_SHARED_PAIRS = 30;
const LOW_AGREEMENT = 0.6;

export type VoteReviewSession = {
  sessionId: string;
  label: string;
  location: string | null;
  lastVoteAt: string | null;
  lastVoteId: string | null;
  votes: number;
  choiceA: number;
  choiceB: number;
  ties: number;
  bothBad: number;
  medianGapSeconds: number | null;
  fastVotes: number;
  repeatVotes: number;
  sharedPairs: number;
  agreement: number | null;
  flags: string[];
  person: string;
  kept: boolean;
  blocked: boolean;
  networkLabel: string | null;
  matchingSessions: number;
  reviewedUserId: string | null;
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

type Metrics = Pick<VoteReviewSession, "votes" | "choiceA" | "choiceB" | "bothBad" | "fastVotes" | "repeatVotes" | "sharedPairs" | "agreement">;

export function voteReviewFlags(row: Metrics): string[] {
  const flags: string[] = [];
  const decisive = row.choiceA + row.choiceB;
  if (row.votes >= 20 && row.fastVotes >= (row.votes - 1) / 2) flags.push("Rapid voting");
  if (decisive >= 20 && Math.max(row.choiceA, row.choiceB) / decisive >= 0.9) flags.push("One-sided voting");
  if (row.sharedPairs >= MIN_SHARED_PAIRS && row.agreement != null && row.agreement < LOW_AGREEMENT) flags.push("Low agreement");
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

// a build file replaced in place keeps its ID, so votes cast before the replacement judged a different build
async function buildReplacedAt(): Promise<Array<{ id: string; at: Date }>> {
  // databases without Supabase storage have no replaced files
  const [storage] = await prisma.$queryRaw<[{ present: boolean }]>`SELECT to_regclass('storage.objects') IS NOT NULL AS present`;
  if (!storage.present) return [];
  return prisma.$queryRaw<Array<{ id: string; at: Date }>>`
    SELECT b.id, o.updated_at AS at FROM "Build" b
    JOIN storage.objects o ON o.bucket_id = b."voxelStorageBucket" AND o.name = b."voxelStoragePath"
    WHERE o.updated_at IS NOT NULL`;
}

export async function getArenaVoteReview(adminId: string): Promise<VoteReviewData> {
  await requireMineBenchAdmin(adminId);
  const now = new Date();
  const since = new Date(now.getTime() - VOTE_REVIEW_WINDOW_MS);
  const retainedSince = new Date(now.getTime() - PUBLIC_SESSION_RETENTION_MS);
  const ranking = await latestRanks();
  type Summary = Metrics & { sessionId: string; person: string; userId: string | null; lastVoteAt: Date | null; lastVoteId: string | null; ties: number; medianGapSeconds: number | null };
  const [blocks, keeps, replaced] = await Promise.all([
    prisma.galleryVoteBlock.findMany({ where: { reversedAt: null }, select: { userId: true, sessionHash: true, ipHmac: true } }),
    prisma.arenaVoteReviewKeep.findMany({ select: { person: true } }),
    buildReplacedAt(),
  ]);
  const kept = new Set(keeps.map(keep => keep.person));
  const ipBlocks = blocks.flatMap(block => block.ipHmac ? [block.ipHmac] : []);
  const blockedSessions = new Set(blocks.flatMap(block => block.sessionHash ? [block.sessionHash] : []));
  const blockedUsers = new Set(blocks.flatMap(block => block.userId ? [block.userId] : []));
  // ponytail: scan retained session IDs for hash matches until volume warrants an indexed hash
  const blockedSessionIds = blockedSessions.size ? (await prisma.publicSessionActivity.findMany({
    where: { lastSeenAt: { gte: retainedSince } }, select: { sessionId: true },
  })).filter(session => blockedSessions.has(hashVoteSession(session.sessionId)!)).map(session => session.sessionId) : [];
  const blockedIpSessionIds = ipBlocks.length ? (await prisma.publicSessionActivity.findMany({
    where: { ipHmac: { in: ipBlocks } }, select: { sessionId: true },
  })).map(session => session.sessionId) : [];
  // ponytail: scans every vote, about 4s at 258k votes; precompute per person if the page slows down
  const allRows = await prisma.$queryRaw<Summary[]>(Prisma.sql`
    WITH replaced AS (
      SELECT * FROM unnest(${replaced.map(row => row.id)}::text[], ${replaced.map(row => row.at.toISOString())}::timestamptz[]) AS r(id, at)
    ), votes AS (
      SELECT v.id, v."sessionId", v."userId"::text AS "userId", v.choice, v."createdAt",
        LEAST(m."buildAId", m."buildBId") AS first_build, GREATEST(m."buildAId", m."buildBId") AS second_build,
        (v.choice = 'A') = (m."buildAId" < m."buildBId") AS picked_first,
        -- agreement follows the judge's data, current build versions only and no restricted votes
        COALESCE(v."createdAt" >= (ra.at AT TIME ZONE 'UTC'), true) AND COALESCE(v."createdAt" >= (rb.at AT TIME ZONE 'UTC'), true)
          AND v."sessionId" <> ALL(${[...blockedSessionIds, ...blockedIpSessionIds]}::text[])
          AND COALESCE(v."userId"::text <> ALL(${[...blockedUsers]}::text[]), true) AS comparable,
        EXTRACT(EPOCH FROM v."createdAt" - LAG(v."createdAt") OVER (
          PARTITION BY v."sessionId" ORDER BY v."createdAt", v.id
        ))::double precision AS gap
      FROM "Vote" v JOIN "Matchup" m ON m.id = v."matchupId"
      LEFT JOIN replaced ra ON ra.id = m."buildAId"
      LEFT JOIN replaced rb ON rb.id = m."buildBId"
      WHERE v."createdAt" <= (${now}::timestamptz AT TIME ZONE 'UTC') AND m."stealthVariantId" IS NULL
    ), sessions AS (
      SELECT "sessionId",
        (array_agg("userId" ORDER BY "createdAt" DESC, id DESC) FILTER (WHERE "userId" IS NOT NULL))[1] AS "userId",
        MAX("createdAt") AS "lastVoteAt",
        (array_agg(id ORDER BY "createdAt" DESC, id DESC))[1] AS "lastVoteId",
        COUNT(*)::int AS votes,
        COUNT(*) FILTER (WHERE choice = 'A')::int AS "choiceA",
        COUNT(*) FILTER (WHERE choice = 'B')::int AS "choiceB",
        COUNT(*) FILTER (WHERE choice = 'TIE')::int AS ties,
        COUNT(*) FILTER (WHERE choice = 'BOTH_BAD')::int AS "bothBad",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap) AS "medianGapSeconds",
        COUNT(*) FILTER (WHERE gap < 2)::int AS "fastVotes",
        (COUNT(*) - COUNT(DISTINCT (first_build, second_build)))::int AS "repeatVotes"
      FROM votes GROUP BY "sessionId"
    ), opinions AS (
      -- one opinion per person per pair as in the judge's data, the chance they pick the pair's first build
      SELECT COALESCE(s."userId", v."sessionId") AS person, first_build, second_build,
        AVG(CASE WHEN choice = 'TIE' THEN 0.5 WHEN picked_first THEN 1 ELSE 0 END)::double precision AS y
      FROM votes v JOIN sessions s USING ("sessionId") WHERE choice <> 'BOTH_BAD' AND comparable GROUP BY 1, 2, 3
    ), pairs AS (
      SELECT first_build, second_build, SUM(y) AS total, COUNT(*) AS people FROM opinions GROUP BY 1, 2
    ), agreement AS (
      -- mean chance of picking the same build as each other person on the same pair
      SELECT o.person, COUNT(*)::int AS "sharedPairs",
        AVG(o.y * (p.total - o.y) / (p.people - 1) + (1 - o.y) * (1 - (p.total - o.y) / (p.people - 1))) AS agreement
      FROM opinions o JOIN pairs p USING (first_build, second_build) WHERE p.people > 1 GROUP BY 1
    )
    SELECT s.*, COALESCE(s."userId", s."sessionId") AS person, COALESCE(a."sharedPairs", 0) AS "sharedPairs", a.agreement
    FROM sessions s LEFT JOIN agreement a ON a.person = COALESCE(s."userId", s."sessionId")
    -- older sessions can only be flagged with 20 votes or enough shared pairs
    WHERE s."lastVoteAt" >= (${since}::timestamptz AT TIME ZONE 'UTC') OR s.votes >= 20 OR a."sharedPairs" >= ${MIN_SHARED_PAIRS}
    ORDER BY s."lastVoteAt" DESC, s."sessionId"
  `);
  // unreviewed flags always show, while kept people and the last 24 hours share the session limit
  let listed = 0;
  const rows = allRows.filter(row => {
    const flagged = voteReviewFlags(row).length > 0;
    if (flagged && !kept.has(row.person)) return true;
    return (flagged || row.lastVoteAt! >= since) && listed++ < SESSION_LIMIT;
  });

  const sessions = await prisma.publicSessionActivity.findMany({
    where: { lastSeenAt: { gte: retainedSince }, OR: [
      { sessionId: { in: [...rows.map(row => row.sessionId), ...blockedSessionIds] } },
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
  const summaries = new Map(rows.map(row => [row.sessionId, row]));
  // keep restricted visitors visible after their votes are removed
  for (const session of sessions) {
    if (!summaries.has(session.sessionId) && (
      blockedSessions.has(hashVoteSession(session.sessionId)!) ||
      Boolean(session.userId && blockedUsers.has(session.userId)) ||
      Boolean(session.ipHmac && blockedIps.has(session.ipHmac))
    )) {
      summaries.set(session.sessionId, { sessionId: session.sessionId, person: session.userId ?? session.sessionId, userId: session.userId,
        lastVoteAt: null, lastVoteId: null, votes: 0, choiceA: 0, choiceB: 0, ties: 0, bothBad: 0, medianGapSeconds: null,
        fastVotes: 0, repeatVotes: 0, sharedPairs: 0, agreement: null });
    }
  }
  return {
    since: since.toISOString(), until: now.toISOString(), rankingAt: ranking.capturedAt?.toISOString() ?? null,
    truncated: listed > SESSION_LIMIT || sessions.length > SESSION_LIMIT,
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
        kept: kept.has(row.person),
        reviewedUserId: userId ?? null,
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

export async function setArenaVoteReviewKept(adminId: string, person: string, keep: boolean): Promise<{ kept: boolean }> {
  await requireMineBenchAdmin(adminId);
  checkSession(person);
  if (keep) await prisma.arenaVoteReviewKeep.upsert({ where: { person }, create: { person, createdById: adminId }, update: {} });
  else await prisma.arenaVoteReviewKeep.deleteMany({ where: { person } });
  return { kept: keep };
}

export async function setArenaVoteSessionBlocked(
  adminId: string,
  sessionId: string,
  blocked: boolean,
  reviewedSince?: string,
  reviewedUntil?: string,
  reviewedUserId?: string | null,
): Promise<{ blocked: boolean; personId: string | null; label: string }> {
  await requireMineBenchAdmin(adminId);
  checkSession(sessionId);
  // Use the reviewed identity captured at review load time to avoid mis-targeting
  // a user who signed in (or had votes claimed) after the admin confirmed the review.
  // reviewedUserId === null means the snapshot identified a guest (no user ID at review time);
  // skip the live vote-based re-resolution so a guest who signed in after load isn't blocked instead.
  if (reviewedUserId !== undefined && reviewedUserId !== null) {
    const personId = `user:${reviewedUserId}`;
    const { label } = await setGalleryPersonVoteBlocked(adminId, personId, blocked);
    return { blocked, personId, label };
  }
  // If the snapshot explicitly recorded no user (null), skip live re-resolution via votes
  // and fall through directly to session/hash-based blocking.
  const skipLiveResolution = reviewedUserId === null;
  if (!skipLiveResolution) {
    const parsedSince = reviewedSince ? new Date(reviewedSince) : null;
    const since = parsedSince && Number.isFinite(parsedSince.getTime()) ? parsedSince : new Date(0);
    const parsedUntil = reviewedUntil ? new Date(reviewedUntil) : null;
    const until = parsedUntil && Number.isFinite(parsedUntil.getTime()) ? parsedUntil : new Date();
    const vote = await prisma.vote.findFirst({
      where: { sessionId, userId: { not: null }, createdAt: { gte: since, lte: until }, matchup: { stealthVariantId: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { userId: true },
    });
    if (vote?.userId) {
      const personId = `user:${vote.userId}`;
      const { label } = await setGalleryPersonVoteBlocked(adminId, personId, blocked);
      return { blocked, personId, label };
    }
    const presence = await prisma.publicSessionActivity.findUnique({ where: { sessionId }, select: { id: true, userId: true } });
    if (presence?.userId) {
      const personId = `user:${presence.userId}`;
      const { label } = await setGalleryPersonVoteBlocked(adminId, personId, blocked);
      return { blocked, personId, label };
    }
  }
  // For anonymous snapshots, block by session record rather than re-resolving a user.
  const presenceForAnon = skipLiveResolution
    ? await prisma.publicSessionActivity.findUnique({ where: { sessionId }, select: { id: true } })
    : null;
  if (presenceForAnon) {
    const personId = `session:${presenceForAnon.id}`;
    const { label } = await setGalleryPersonVoteBlocked(adminId, personId, blocked);
    return { blocked, personId, label };
  }
  const sessionHash = hashVoteSession(sessionId)!;
  const existing = await prisma.galleryVoteBlock.findMany({ where: { sessionHash, reversedAt: null }, select: { id: true } });
  if (blocked && existing.length === 0) await createVoteBlock(adminId, { sessionId });
  if (!blocked) for (const block of existing) await reverseVoteBlock(adminId, block.id);
  return { blocked, personId: null, label: `Guest ${sessionHash.slice(0, 6).toUpperCase()}` };
}
