import { Prisma } from "@prisma/client";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 40;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

function isRetryableArenaWriteError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2028" || error.code === "P2034") return true;
  }

  const message = getErrorMessage(error);
  return (
    message.includes("deadlock detected") ||
    message.includes("40P01") ||
    message.includes("Transaction already closed") ||
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
      if (!isRetryableArenaWriteError(error) || attempt >= MAX_ATTEMPTS - 1) {
        throw error;
      }

      await sleep(BASE_DELAY_MS * 2 ** attempt);
      attempt += 1;
    }
  }
}
