const DB_UNAVAILABLE_PATTERNS = [
  "Can't reach database server",
  "ECHECKOUTTIMEOUT",
  "ECIRCUITBREAKER",
  "Connection terminated due to connection timeout",
  "Error in PostgreSQL connection",
  "Failed to connect to database",
  "P1001",
];

// Prisma reports these on the error object rather than in the message, so
// matching text alone misses them — pool exhaustion (P2024) in particular,
// which is the one that shows up under load.
const DB_UNAVAILABLE_CODES = new Set([
  "P1001", // can't reach the database server
  "P1002", // server reached but timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
  "P2024", // timed out fetching a connection from the pool
]);

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && DB_UNAVAILABLE_CODES.has(code)) return true;
  const message = getErrorMessage(error, "");
  return DB_UNAVAILABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

export function databaseUnavailableBody() {
  return { error: "Database is temporarily unavailable." };
}

export function databaseUnavailableHeaders(): HeadersInit {
  return { "Retry-After": "10" };
}
