import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const DEFAULT_PGBOUNCER_CONNECTION_LIMIT = "1";

function normalizeDatasourceUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;

  try {
    const url = new URL(rawUrl);
    const usesPgBouncer =
      url.searchParams.get("pgbouncer") === "true" || url.hostname.includes("pooler.supabase.com");

    if (usesPgBouncer && !url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", DEFAULT_PGBOUNCER_CONNECTION_LIMIT);
      return url.toString();
    }
  } catch {
    return rawUrl;
  }

  return rawUrl;
}

const datasourceUrl = normalizeDatasourceUrl(process.env.DATABASE_URL);
const prismaClientOptions = {
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  ...(datasourceUrl ? { datasourceUrl } : {}),
} satisfies ConstructorParameters<typeof PrismaClient>[0];

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient(prismaClientOptions);

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
