import { Prisma } from "@prisma/client";

export const ARENA_WRITE_RETRY_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 40;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

export function isArenaCapacityError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034" || error.code === "P2028" || error.code === "P2024") {
      return true;
    }
  }

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("deadlock detected") ||
    message.includes("55p03") ||
    message.includes("40p01") ||
    message.includes("could not obtain lock") ||
    message.includes("could not serialize access due to") ||
    message.includes("serialization failure") ||
    message.includes("please retry your transaction") ||
    message.includes("unable to start a transaction") ||
    message.includes("transaction already closed") ||
    message.includes("timed out after") ||
    message.includes("timed out, please try again") ||
    message.includes("timed out fetching a new connection") ||
    message.includes("connection pool") ||
    message.includes("pool_timeout") ||
    message.includes("too many connections") ||
    message.includes("arena optimistic model conflict") ||
    message.includes("write conflict")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withArenaWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await run();
    } catch (error) {
      if (!isArenaCapacityError(error) || attempt >= ARENA_WRITE_RETRY_MAX_ATTEMPTS - 1) {
        throw error;
      }

      const backoffMs = BASE_DELAY_MS * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * BASE_DELAY_MS);
      await sleep(backoffMs + jitterMs);
      attempt += 1;
    }
  }
}
