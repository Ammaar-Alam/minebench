#!/usr/bin/env -S tsx

import "dotenv/config";
import { Prisma } from "@prisma/client";
import { databaseIdentityFromUrl } from "../lib/db/identity";
import { prisma } from "../lib/prisma";

type Args = {
  dryRun: boolean;
  days: number;
  batchSize: number;
};

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
const DEFAULT_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 20000;

const JOB_TABLES = ["ArenaVoteJob", "ArenaShownJob"] as const;

type JobTable = (typeof JOB_TABLES)[number];

function parsePositiveIntArg(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const parsed = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const days = parsePositiveIntArg(args, "--days", DEFAULT_RETENTION_DAYS);
  if (days < MIN_RETENTION_DAYS) {
    throw new Error(`--days must be at least ${MIN_RETENTION_DAYS}`);
  }
  return {
    dryRun: args.includes("--dry-run"),
    days,
    batchSize: Math.min(parsePositiveIntArg(args, "--batch", DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE),
  };
}

async function countPrunable(table: JobTable, cutoff: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE "processedAt" IS NOT NULL AND "processedAt" < ${cutoff}
  `);
  return Number(rows[0]?.count ?? 0);
}

async function deleteBatch(table: JobTable, cutoff: Date, batchSize: number): Promise<number> {
  // each batch is its own statement so drains never wait on a long delete
  return prisma.$executeRaw(Prisma.sql`
    DELETE FROM ${Prisma.raw(`"${table}"`)}
    WHERE "id" IN (
      SELECT "id"
      FROM ${Prisma.raw(`"${table}"`)}
      WHERE "processedAt" IS NOT NULL AND "processedAt" < ${cutoff}
      ORDER BY "processedAt" ASC
      LIMIT ${batchSize}
    )
  `);
}

async function reportRetained(table: JobTable): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{ pending: bigint | number; processed: bigint | number; oldestProcessed: Date | null }>
  >(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE "processedAt" IS NULL) AS "pending",
      COUNT(*) FILTER (WHERE "processedAt" IS NOT NULL) AS "processed",
      MIN("processedAt") AS "oldestProcessed"
    FROM ${Prisma.raw(`"${table}"`)}
  `);
  const row = rows[0];
  const oldest = row?.oldestProcessed ? row.oldestProcessed.toISOString() : "none";
  console.log(
    `- ${table}: retained pending=${Number(row?.pending ?? 0)} processed=${Number(
      row?.processed ?? 0,
    )} oldestProcessed=${oldest}`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const cutoff = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  // deletes are irreversible, so name the database before doing any: the only
  // thing separating staging from production here is the environment wrapper
  const target = databaseIdentityFromUrl(process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "");
  if (!target) {
    throw new Error("Could not identify the target database from DATABASE_URL");
  }

  console.log("Pruning processed arena job history");
  console.log(`- database: ${target.projectRef ?? `${target.host}:${target.port}/${target.database}`}`);
  console.log(`- cutoff: ${cutoff.toISOString()} (${args.days} days)`);
  console.log(`- batch size: ${args.batchSize}`);
  console.log(`- dry run: ${args.dryRun ? "yes" : "no"}`);

  for (const table of JOB_TABLES) {
    const prunable = await countPrunable(table, cutoff);
    if (args.dryRun) {
      console.log(`- ${table}: would delete ${prunable}`);
      continue;
    }

    let deleted = 0;
    while (deleted < prunable) {
      const batchDeleted = await deleteBatch(table, cutoff, args.batchSize);
      if (batchDeleted <= 0) break;
      deleted += batchDeleted;
      console.log(`- ${table}: deleted ${deleted}/${prunable}`);
    }
    if (deleted === 0) console.log(`- ${table}: nothing to delete`);
  }

  if (!args.dryRun) {
    for (const table of JOB_TABLES) {
      await reportRetained(table);
    }
  }
}

void main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
