// Helpers with identical semantics across provider adapters
// Provider-specific variants (error vocabularies, content extraction, base URL
// rules) stay in their own adapter files

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

export function requestIdFromResponse(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null;
}

export function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}
