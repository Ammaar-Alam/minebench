export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (!error || (typeof error !== "object" && typeof error !== "function")) return fallback;

  try {
    const message = Reflect.get(error, "message");
    return typeof message === "string" && message.trim() ? message : fallback;
  } catch {
    return fallback;
  }
}
