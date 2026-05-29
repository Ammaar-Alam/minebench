const DB_UNAVAILABLE_PATTERNS = [
  "Can't reach database server",
  "ECHECKOUTTIMEOUT",
  "ECIRCUITBREAKER",
  "Connection terminated due to connection timeout",
  "Error in PostgreSQL connection",
  "P1001",
];

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  const message = getErrorMessage(error, "");
  return DB_UNAVAILABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

export function databaseUnavailableBody() {
  return { error: "Database is temporarily unavailable." };
}

export function databaseUnavailableHeaders(): HeadersInit {
  return { "Retry-After": "10" };
}
