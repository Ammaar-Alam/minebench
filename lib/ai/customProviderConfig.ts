export type CustomRequestEntry = {
  name: string;
  value: string;
};

export type CustomRequestHeaders = Record<string, string>;
export type CustomRequestBody = Record<string, unknown>;

export type CustomProviderProfile = {
  providerName: string;
  modelId: string;
  baseUrl: string;
  headers: CustomRequestEntry[];
  body: CustomRequestEntry[];
};

export type CustomProviderRequestConfig = {
  baseUrl: string;
  headers?: CustomRequestHeaders;
  body?: CustomRequestBody;
};

const CUSTOM_PROVIDER_STORAGE_KEY = "mb_custom_provider_profile_v1";
export const MAX_CUSTOM_REQUEST_ENTRIES = 32;
const MAX_CUSTOM_REQUEST_VALUE_LENGTH = 16_384;
const MAX_CUSTOM_REQUEST_BYTES = 65_536;
const MAX_CUSTOM_OUTPUT_TOKENS = 1_000_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const BLOCKED_BODY_FIELDS = new Set([
  "__proto__",
  "constructor",
  "messages",
  "model",
  "prototype",
  "response_format",
  "stream",
]);

export function emptyCustomProviderProfile(): CustomProviderProfile {
  return {
    providerName: "",
    modelId: "",
    baseUrl: "",
    headers: [],
    body: [],
  };
}

function storedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function storedEntries(value: unknown): CustomRequestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CUSTOM_REQUEST_ENTRIES).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    if (typeof source.name !== "string" || typeof source.value !== "string") return [];
    return [{
      name: source.name.slice(0, 128),
      value: source.value.slice(0, MAX_CUSTOM_REQUEST_VALUE_LENGTH),
    }];
  });
}

export function parseCustomProviderProfile(value: unknown): CustomProviderProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyCustomProviderProfile();
  }
  const source = value as Record<string, unknown>;
  return {
    providerName: storedString(source.providerName, 120),
    modelId: storedString(source.modelId, 240),
    baseUrl: storedString(source.baseUrl, 4_000),
    headers: storedEntries(source.headers),
    body: storedEntries(source.body),
  };
}

export function loadCustomProviderProfile(): CustomProviderProfile {
  if (typeof window === "undefined") return emptyCustomProviderProfile();
  try {
    return parseCustomProviderProfile(
      JSON.parse(window.localStorage.getItem(CUSTOM_PROVIDER_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return emptyCustomProviderProfile();
  }
}

export function saveCustomProviderProfile(profile: CustomProviderProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CUSTOM_PROVIDER_STORAGE_KEY,
      JSON.stringify(parseCustomProviderProfile(profile)),
    );
  } catch {
    // Local storage can be unavailable in restricted browser contexts
  }
}

function assertEntryCount(entries: Array<[string, unknown]>, label: string): void {
  if (entries.length > MAX_CUSTOM_REQUEST_ENTRIES) {
    throw new Error(`Use no more than ${MAX_CUSTOM_REQUEST_ENTRIES} custom ${label}.`);
  }
}

function normalizeHeaders(headers: CustomRequestHeaders | undefined): CustomRequestHeaders {
  const entries = Object.entries(headers ?? {});
  assertEntryCount(entries, "headers");
  const seen = new Set<string>();
  const normalized: Array<[string, string]> = [];
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    const lowerName = name.toLowerCase();
    if (!name || name.length > 128 || !HEADER_NAME.test(name)) {
      throw new Error("Use valid HTTP header names.");
    }
    if (BLOCKED_HEADERS.has(lowerName)) {
      throw new Error(`${name} is managed by MineBench and cannot be customized.`);
    }
    if (seen.has(lowerName)) throw new Error("Header names must be unique.");
    if (typeof rawValue !== "string" || rawValue.length > MAX_CUSTOM_REQUEST_VALUE_LENGTH) {
      throw new Error(`Keep ${name} under ${MAX_CUSTOM_REQUEST_VALUE_LENGTH.toLocaleString()} characters.`);
    }
    if (/\r|\n/.test(rawValue)) throw new Error(`Remove line breaks from ${name}.`);
    seen.add(lowerName);
    normalized.push([name, rawValue.trim()]);
  }
  return Object.fromEntries(normalized);
}

function normalizeBody(body: CustomRequestBody | undefined): CustomRequestBody {
  const entries = Object.entries(body ?? {});
  assertEntryCount(entries, "body parameters");
  const normalized: Array<[string, unknown]> = [];
  for (const [rawName, value] of entries) {
    const name = rawName.trim();
    if (!name || name.length > 128) throw new Error("Add a name to each body parameter.");
    if (BLOCKED_BODY_FIELDS.has(name.toLowerCase())) {
      throw new Error(`${name} is managed by MineBench and cannot be customized.`);
    }
    normalized.push([name, value]);
  }
  const result = Object.fromEntries(normalized);
  if (Object.hasOwn(result, "max_tokens") && Object.hasOwn(result, "max_completion_tokens")) {
    throw new Error("Use either max_tokens or max_completion_tokens, not both.");
  }
  for (const name of ["max_tokens", "max_completion_tokens"] as const) {
    if (!Object.hasOwn(result, name)) continue;
    const value = result[name];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_CUSTOM_OUTPUT_TOKENS
    ) {
      throw new Error(`${name} must be a number from 1 to ${MAX_CUSTOM_OUTPUT_TOKENS}.`);
    }
    result[name] = Math.floor(value);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("Custom body parameters must be valid JSON values.");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CUSTOM_REQUEST_BYTES) {
    throw new Error("Keep custom body parameters under 64 KB.");
  }
  return result;
}

export function normalizeCustomProviderRequestConfig(
  config: CustomProviderRequestConfig,
): CustomProviderRequestConfig {
  const baseUrl = config.baseUrl.trim();
  const headers = normalizeHeaders(config.headers);
  const body = normalizeBody(config.body);
  return {
    baseUrl,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(body).length > 0 ? { body } : {}),
  };
}

function entriesToHeaders(entries: CustomRequestEntry[]): CustomRequestHeaders {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim();
    const value = entry.value.trim();
    if (!name && !value) continue;
    if (!name) throw new Error("Add a name to each header.");
    const lowerName = name.toLowerCase();
    if (seen.has(lowerName)) throw new Error("Header names must be unique.");
    seen.add(lowerName);
    pairs.push([name, value]);
  }
  return Object.fromEntries(pairs);
}

function parseBodyValue(value: string): unknown {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return normalized;
  }
}

function entriesToBody(entries: CustomRequestEntry[]): CustomRequestBody {
  const pairs: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim();
    const value = entry.value.trim();
    if (!name && !value) continue;
    if (!name) throw new Error("Add a name to each body parameter.");
    if (seen.has(name)) throw new Error("Body parameter names must be unique.");
    seen.add(name);
    pairs.push([name, parseBodyValue(value)]);
  }
  return Object.fromEntries(pairs);
}

export function customProviderRequestConfigFromProfile(
  profile: CustomProviderProfile,
): CustomProviderRequestConfig {
  return normalizeCustomProviderRequestConfig({
    baseUrl: profile.baseUrl,
    headers: entriesToHeaders(profile.headers),
    body: entriesToBody(profile.body),
  });
}

export function serializeCustomProviderRequestConfig(
  config: CustomProviderRequestConfig,
): string {
  const normalized = normalizeCustomProviderRequestConfig(config);
  if (!normalized.headers && !normalized.body) return normalized.baseUrl;
  return JSON.stringify({ version: 1, ...normalized });
}

export function deserializeCustomProviderRequestConfig(
  value: string,
): CustomProviderRequestConfig {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { version?: unknown }).version === 1 &&
      typeof (parsed as { baseUrl?: unknown }).baseUrl === "string"
    ) {
      const config = parsed as {
        baseUrl: string;
        headers?: CustomRequestHeaders;
        body?: CustomRequestBody;
      };
      return normalizeCustomProviderRequestConfig(config);
    }
  } catch {
    // Legacy endpoint secrets contain the URL directly
  }
  return normalizeCustomProviderRequestConfig({ baseUrl: value });
}

export function customProviderMaxOutputTokens(
  body: CustomRequestBody | undefined,
): number | undefined {
  const value = body?.max_tokens ?? body?.max_completion_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
