import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const SLOW_QUERY_LOG_MS = Number.parseInt(
  process.env.PRISMA_SLOW_QUERY_LOG_MS ?? "500",
  10,
);

// const-asserted log array gives $on("query", ...) type-safe access in prisma 6.
const PRISMA_LOG = [
  { emit: "event", level: "query" },
  process.env.NODE_ENV === "development"
    ? ({ emit: "stdout", level: "warn" } as const)
    : null,
  { emit: "stdout", level: "error" },
].filter(Boolean) as ReadonlyArray<Prisma.LogDefinition>;

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [...PRISMA_LOG] as Prisma.LogDefinition[],
  });
  if (Number.isFinite(SLOW_QUERY_LOG_MS) && SLOW_QUERY_LOG_MS > 0) {
    // typed-cast: $on("query", ...) is only typed when emit:"event" is in the log array
    (client as unknown as {
      $on: (
        event: "query",
        cb: (event: { duration: number; query: string }) => void,
      ) => void;
    }).$on("query", (event) => {
      if (event.duration >= SLOW_QUERY_LOG_MS) {
        // keep the log line short; vercel parses these as structured errors when needed
        console.warn(
          `prisma slow query ${event.duration}ms ${event.query.slice(0, 240)}`,
        );
      }
    });
  }
  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
