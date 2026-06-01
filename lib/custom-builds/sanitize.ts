const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_SECRET_RE =
  /\b(api[_-]?key|authorization|provider[_-]?key|token|secret)\s*[:=]\s*["']?[^"',\s]+/gi;
const API_KEY_RE = /\b(?:sk-or-v1-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})\b/g;

export function redactSensitiveText(value: unknown, maxLength = 2_000): string {
  const input = value instanceof Error ? value.message : String(value ?? "");
  const redacted = input
    .replace(BEARER_TOKEN_RE, "Bearer [redacted]")
    .replace(KEY_VALUE_SECRET_RE, (_match, name: string) => `${name}=[redacted]`)
    .replace(API_KEY_RE, "[redacted]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}
