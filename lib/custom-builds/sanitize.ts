const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_SECRET_RE =
  /(["']?(?:api[_-]?key|apiKey|provider[_-]?key|providerKey|access[_-]?token|accessToken|authorization|client[_-]?secret|clientSecret|secret|token|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',{}]+)/gi;
const API_KEY_RE =
  /\b(?:sk-or-v1-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_-]{20,})\b/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

export function redactSensitiveText(value: unknown, maxLength = 2_000): string {
  const input = value instanceof Error ? value.message : String(value ?? "");
  const redacted = input
    .replace(BEARER_TOKEN_RE, "Bearer [redacted]")
    .replace(KEY_VALUE_SECRET_RE, (_match, prefix: string) => {
      const hasQuote = prefix.includes('"') || prefix.includes("'");
      return `${prefix}${hasQuote ? '"[redacted]"' : "[redacted]"}`;
    })
    .replace(API_KEY_RE, "[redacted]")
    .replace(URL_RE, "[redacted-url]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...` : redacted;
}

export function safeCustomBuildRetryReason(reason: unknown): string {
  const redacted = redactSensitiveText(reason, 2_000).trim();
  if (!redacted) {
    return "The first response could not be used.";
  }
  return redacted;
}
