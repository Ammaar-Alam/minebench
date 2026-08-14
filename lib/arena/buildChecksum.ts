const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function normalizeArenaBuildChecksum(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SHA256_PATTERN.test(normalized) ? normalized : null;
}
