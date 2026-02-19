#!/usr/bin/env npx tsx
/**
 * Reset Arena ELO + stats (without deleting builds).
 *
 * Usage:
 *   pnpm elo:reset                 # dry run
 *   pnpm elo:reset --yes           # apply changes
 *   pnpm elo:reset --yes --keep-history  # keep matchups/votes, reset model stats only
 */

import "dotenv/config";
import { prisma } from "../lib/prisma";

function getDbInfo() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "") || "unknown";
    return {
      host: u.hostname || "unknown",
      port: u.port || "5432",
      database,
      pgbouncer: u.searchParams.get("pgbouncer") === "true",
    };
  } catch {
    return { host: "unknown", port: "unknown", database: "unknown", pgbouncer: false };
  }
}

function parseArgs(argv: string[]) {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    yes: argv.includes("--yes") || argv.includes("--apply"),
    keepHistory: argv.includes("--keep-history"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Reset MineBench Arena ELO + stats (keeps builds).

Usage:
  pnpm elo:reset                 # dry run
  pnpm elo:reset --yes           # apply changes
  pnpm elo:reset --yes --keep-history  # keep matchups/votes, reset model stats only
`.trim());
    return;
  }

  const db = getDbInfo();
  const [modelTotal, matchupTotal, voteTotal] = await Promise.all([
    prisma.model.count(),
    prisma.matchup.count(),
    prisma.vote.count(),
  ]);

  console.log(`db: ${db ? `${db.host}:${db.port}/${db.database}${db.pgbouncer ? " (pgbouncer)" : ""}` : "unknown"}`);
  console.log(`models: ${modelTotal}`);
  console.log(`matchups: ${matchupTotal}`);
  console.log(`votes: ${voteTotal}`);

  if (!args.yes) {
    console.log("dry run: pass --yes to apply");
    return;
  }

  const before = { matchupTotal, voteTotal };

  const result = await prisma.$transaction(async (tx) => {
    let deletedVotes = 0;
    let deletedMatchups = 0;

    if (!args.keepHistory) {
      const dv = await tx.vote.deleteMany();
      deletedVotes = dv.count;

      const dm = await tx.matchup.deleteMany();
      deletedMatchups = dm.count;
    }

    const updatedModels = await tx.model.updateMany({
      data: {
        eloRating: 1500,
        glickoRd: 350,
        glickoVolatility: 0.06,
        conservativeRating: 800,
        shownCount: 0,
        winCount: 0,
        lossCount: 0,
        drawCount: 0,
        bothBadCount: 0,
      },
    });

    return { deletedVotes, deletedMatchups, updatedModels: updatedModels.count };
  });

  console.log("done");
  console.log(`models reset: ${result.updatedModels}`);
  if (args.keepHistory) {
    console.log("history kept: matchups/votes unchanged");
  } else {
    console.log(`votes deleted: ${result.deletedVotes} (was ${before.voteTotal})`);
    console.log(`matchups deleted: ${result.deletedMatchups} (was ${before.matchupTotal})`);
  }
}

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
