#!/usr/bin/env -S tsx

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import { databaseIdentityFromUrl } from "../lib/db/identity";
import { prisma } from "../lib/prisma";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AuditSelector =
  | { kind: "email"; value: string }
  | { kind: "userId"; value: string }
  | { kind: "voteId"; value: string };

export type VoteAuditArgs = {
  beforeVoteId: string | null;
  help: boolean;
  json: boolean;
  limit: number;
  selector: AuditSelector | null;
  sessionId: string | null;
};

type NumberLike = bigint | number | string | null;

type SummaryRow = {
  totalVotes: NumberLike;
  sessions: NumberLike;
  firstVoteAt: Date | null;
  latestVoteAt: Date | null;
  votes5m: NumberLike;
  votes1h: NumberLike;
  votes24h: NumberLike;
  votes7d: NumberLike;
  choiceA: NumberLike;
  choiceB: NumberLike;
  choiceTie: NumberLike;
  choiceBothBad: NumberLike;
};

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} expects a value`);
  return value;
}

export function parseVoteAuditArgs(argv: string[]): VoteAuditArgs {
  const args = argv.slice(2);
  let selector: AuditSelector | null = null;
  let sessionId: string | null = null;
  let beforeVoteId: string | null = null;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let help = false;

  const setSelector = (next: AuditSelector) => {
    if (selector) throw new Error("Use exactly one of --email, --user-id, or --vote-id");
    selector = next;
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json") {
      if (json) throw new Error("--json may only be specified once");
      json = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }

    const value = readValue(args, index, flag);
    index += 1;
    switch (flag) {
      case "--email": {
        const email = value.toLowerCase();
        if (email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          throw new Error("--email expects a valid email address");
        }
        setSelector({ kind: "email", value: email });
        break;
      }
      case "--user-id":
        if (!UUID_PATTERN.test(value)) throw new Error("--user-id expects a UUID");
        setSelector({ kind: "userId", value });
        break;
      case "--vote-id":
        if (value.length > 191) throw new Error("--vote-id is too long");
        setSelector({ kind: "voteId", value });
        break;
      case "--session-id":
        if (sessionId) throw new Error("--session-id may only be specified once");
        if (value.length > 191) throw new Error("--session-id is too long");
        sessionId = value;
        break;
      case "--before-vote":
        if (beforeVoteId) throw new Error("--before-vote may only be specified once");
        if (value.length > 191) throw new Error("--before-vote is too long");
        beforeVoteId = value;
        break;
      case "--limit": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
          throw new Error(`--limit expects an integer from 1 to ${MAX_LIMIT}`);
        }
        limit = parsed;
        break;
      }
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (help && args.length > 1) throw new Error("--help cannot be combined with other options");
  if (!help && !selector) throw new Error("Use exactly one of --email, --user-id, or --vote-id");
  return { beforeVoteId, help, json, limit, selector, sessionId };
}

function printHelp() {
  console.log(`Usage:
  pnpm arena:votes:audit --email user@example.com [options]
  pnpm arena:votes:audit --user-id UUID [options]
  pnpm arena:votes:audit --vote-id ID [options]

Options:
  --session-id ID    Limit results to one of the user's sessions
  --before-vote ID   Continue before a vote returned by the previous page
  --limit N          Return 1-${MAX_LIMIT} votes (default ${DEFAULT_LIMIT})
  --json             Print structured JSON
  --help, -h         Show this help`);
}

async function resolveUser(selector: AuditSelector) {
  if (selector.kind === "email") {
    return prisma.user.findUnique({ where: { email: selector.value } });
  }
  if (selector.kind === "userId") {
    return prisma.user.findUnique({ where: { id: selector.value } });
  }
  const vote = await prisma.vote.findUnique({
    where: { id: selector.value },
    select: {
      user: true,
      matchup: { select: { stealthVariantId: true } },
    },
  });
  if (!vote || vote.matchup.stealthVariantId) return null;
  return vote.user;
}

function number(value: NumberLike): number {
  return value == null ? 0 : Number(value);
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function truncatePrompt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

async function runAudit(args: VoteAuditArgs) {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "";
  const database = databaseIdentityFromUrl(databaseUrl);
  if (!database) throw new Error("Could not identify the target database from DATABASE_URL");
  const user = await resolveUser(args.selector!);
  if (!user) throw new Error("No public account was found for that exact selector");

  const sessionFilter = args.sessionId
    ? Prisma.sql`AND vote."sessionId" = ${args.sessionId}`
    : Prisma.empty;
  const summaryRows = await prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
    SELECT
      COUNT(*)::int AS "totalVotes",
      COUNT(DISTINCT vote."sessionId")::int AS sessions,
      MIN(vote."createdAt") AS "firstVoteAt",
      MAX(vote."createdAt") AS "latestVoteAt",
      COUNT(*) FILTER (WHERE vote."createdAt" >= NOW() - INTERVAL '5 minutes')::int AS "votes5m",
      COUNT(*) FILTER (WHERE vote."createdAt" >= NOW() - INTERVAL '1 hour')::int AS "votes1h",
      COUNT(*) FILTER (WHERE vote."createdAt" >= NOW() - INTERVAL '24 hours')::int AS "votes24h",
      COUNT(*) FILTER (WHERE vote."createdAt" >= NOW() - INTERVAL '7 days')::int AS "votes7d",
      COUNT(*) FILTER (WHERE vote.choice = 'A')::int AS "choiceA",
      COUNT(*) FILTER (WHERE vote.choice = 'B')::int AS "choiceB",
      COUNT(*) FILTER (WHERE vote.choice = 'TIE')::int AS "choiceTie",
      COUNT(*) FILTER (WHERE vote.choice = 'BOTH_BAD')::int AS "choiceBothBad"
    FROM "Vote" vote
    INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
    WHERE vote."userId" = CAST(${user.id} AS UUID)
      AND matchup."stealthVariantId" IS NULL
      ${sessionFilter}
  `);
  const summary = summaryRows[0];

  let before: { createdAt: Date; id: string } | null = null;
  if (args.beforeVoteId) {
    before = await prisma.vote.findFirst({
      where: {
        id: args.beforeVoteId,
        userId: user.id,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        matchup: { stealthVariantId: null },
      },
      select: { createdAt: true, id: true },
    });
    if (!before) throw new Error("--before-vote must identify one of this account's public votes");
  }

  const rows = await prisma.vote.findMany({
    where: {
      userId: user.id,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      matchup: { stealthVariantId: null },
      ...(before
        ? {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: args.limit,
    select: {
      id: true,
      createdAt: true,
      sessionId: true,
      choice: true,
      jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { processedAt: true } },
      matchup: {
        select: {
          prompt: { select: { text: true } },
          modelA: { select: { key: true, displayName: true } },
          modelB: { select: { key: true, displayName: true } },
        },
      },
    },
  });

  const votes = rows.map((vote) => ({
    createdAt: vote.createdAt.toISOString(),
    voteId: vote.id,
    sessionId: vote.sessionId,
    choice: vote.choice,
    prompt: truncatePrompt(vote.matchup.prompt.text),
    modelA: vote.matchup.modelA,
    modelB: vote.matchup.modelB,
    jobStatus: vote.jobs[0]?.processedAt ? "processed" : "pending",
  }));

  return {
    database,
    user: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      isMineBenchAdmin: user.isMineBenchAdmin,
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: iso(user.lastSeenAt),
    },
    filter: { sessionId: args.sessionId },
    summary: {
      totalVotes: number(summary?.totalVotes ?? 0),
      sessions: number(summary?.sessions ?? 0),
      firstVoteAt: iso(summary?.firstVoteAt ?? null),
      latestVoteAt: iso(summary?.latestVoteAt ?? null),
      velocity: {
        "5m": number(summary?.votes5m ?? 0),
        "1h": number(summary?.votes1h ?? 0),
        "24h": number(summary?.votes24h ?? 0),
        "7d": number(summary?.votes7d ?? 0),
      },
      choices: {
        A: number(summary?.choiceA ?? 0),
        B: number(summary?.choiceB ?? 0),
        TIE: number(summary?.choiceTie ?? 0),
        BOTH_BAD: number(summary?.choiceBothBad ?? 0),
      },
    },
    votes,
    nextBeforeVote: rows.length === args.limit ? rows.at(-1)?.id ?? null : null,
  };
}

function printHuman(result: Awaited<ReturnType<typeof runAudit>>) {
  const databaseLabel = result.database.projectRef ?? `${result.database.host}:${result.database.port}`;
  console.log("MineBench public vote audit");
  console.log(`Database: ${databaseLabel}/${result.database.database} (${result.database.schema})`);
  console.log(`User: ${result.user.displayName ?? "unnamed"} <${result.user.email}>`);
  console.log(`User ID: ${result.user.userId}`);
  console.log(`MineBench admin: ${result.user.isMineBenchAdmin ? "yes" : "no"}`);
  console.log(`Created: ${result.user.createdAt}`);
  console.log(`Last seen: ${result.user.lastSeenAt ?? "never"}`);
  if (result.filter.sessionId) console.log(`Session filter: ${result.filter.sessionId}`);
  console.log("");
  console.log(`Votes: ${result.summary.totalVotes} across ${result.summary.sessions} session(s)`);
  console.log(`First: ${result.summary.firstVoteAt ?? "none"}`);
  console.log(`Latest: ${result.summary.latestVoteAt ?? "none"}`);
  console.log(
    `Velocity: 5m ${result.summary.velocity["5m"]} | 1h ${result.summary.velocity["1h"]} | 24h ${result.summary.velocity["24h"]} | 7d ${result.summary.velocity["7d"]}`,
  );
  console.log(
    `Choices: A ${result.summary.choices.A} | B ${result.summary.choices.B} | TIE ${result.summary.choices.TIE} | BOTH_BAD ${result.summary.choices.BOTH_BAD}`,
  );
  console.log("");
  console.log(`Recent public votes (${result.votes.length})`);
  for (const vote of result.votes) {
    console.log(`${vote.createdAt}  ${vote.choice}  ${vote.modelA.displayName} vs ${vote.modelB.displayName}`);
    console.log(`  vote ${vote.voteId} | session ${vote.sessionId} | job ${vote.jobStatus}`);
    console.log(`  ${vote.prompt}`);
  }
  if (result.nextBeforeVote) {
    console.log("");
    console.log(`Next page: --before-vote ${result.nextBeforeVote}`);
  }
}

async function main() {
  const args = parseVoteAuditArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  const result = await runAudit(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
    .catch((error) => {
      console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
