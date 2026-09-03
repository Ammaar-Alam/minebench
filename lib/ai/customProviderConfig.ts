export type CustomRequestEntry = {
  name: string;
  value: string;
};

export type CustomRequestHeaders = Record<string, string>;
export type CustomRequestBody = Record<string, unknown>;

export type ProviderRequestOverrides = {
  headers?: CustomRequestHeaders;
  body?: CustomRequestBody;
};

export type CustomProviderProfile = {
  providerName: string;
  modelId: string;
  baseUrl: string;
  headers: CustomRequestEntry[];
  body: CustomRequestEntry[];
};

export type CustomProviderRequestConfig = ProviderRequestOverrides & {
  baseUrl: string;
};

export type SavedGenerationRequestConfig = ProviderRequestOverrides & {
  baseUrl?: string;
};

const CUSTOM_PROVIDER_STORAGE_KEY = "mb_custom_provider_profile_v1";
const MODEL_REQUEST_OVERRIDES_STORAGE_KEY = "mb_model_request_overrides_v1";
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
  "contents",
  "constructor",
  "input",
  "instructions",
  "messages",
  "model",
  "prompt",
  "prototype",
  "response_format",
  "stream",
  "system",
  "systeminstruction",
  "tool_choice",
  "tools",
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

export function parseRequestEntries(value: string): CustomRequestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Check the request overrides.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_CUSTOM_REQUEST_ENTRIES) {
    throw new Error("Check the request overrides.");
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Check the request overrides.");
    }
    const source = entry as Record<string, unknown>;
    if (typeof source.name !== "string" || typeof source.value !== "string") {
      throw new Error("Check the request overrides.");
    }
    return { name: source.name, value: source.value };
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

export function loadModelRequestOverrideProfiles(): Record<
  string,
  { headers: CustomRequestEntry[]; body: CustomRequestEntry[] }
> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(MODEL_REQUEST_OVERRIDES_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .slice(0, 64)
        .flatMap(([key, value]) => {
          if (!key || key.length > 512 || !value || typeof value !== "object") return [];
          const profile = value as Record<string, unknown>;
          return [[key, {
            headers: storedEntries(profile.headers),
            body: storedEntries(profile.body),
          }]];
        }),
    );
  } catch {
    return {};
  }
}

export function saveModelRequestOverrideProfiles(
  profiles: Record<string, { headers: CustomRequestEntry[]; body: CustomRequestEntry[] }>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MODEL_REQUEST_OVERRIDES_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(Object.entries(profiles).slice(-64))),
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

function assertSafeJsonValue(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJsonValue(item);
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Custom body parameters must be valid JSON values.");
  }
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "constructor", "prototype"].includes(name.toLowerCase())) {
      throw new Error(`${name} cannot be customized.`);
    }
    assertSafeJsonValue(item);
  }
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
    assertSafeJsonValue(value);
    normalized.push([name, value]);
  }
  const result = Object.fromEntries(normalized);
  const tokenFields = ["max_tokens", "max_completion_tokens", "max_output_tokens"].filter(
    (name) => Object.hasOwn(result, name),
  );
  if (tokenFields.length > 1) {
    throw new Error("Use only one output token parameter.");
  }
  for (const name of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
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

export function normalizeProviderRequestOverrides(
  overrides: ProviderRequestOverrides,
): ProviderRequestOverrides {
  const headers = normalizeHeaders(overrides.headers);
  const body = normalizeBody(overrides.body);
  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(body).length > 0 ? { body } : {}),
  };
}

export function normalizeCustomProviderRequestConfig(
  config: CustomProviderRequestConfig,
): CustomProviderRequestConfig {
  const baseUrl = config.baseUrl.trim();
  const overrides = normalizeProviderRequestOverrides(config);
  return {
    baseUrl,
    ...overrides,
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

export function providerRequestOverridesFromEntries(
  headers: CustomRequestEntry[],
  body: CustomRequestEntry[],
): ProviderRequestOverrides {
  return normalizeProviderRequestOverrides({
    headers: entriesToHeaders(headers),
    body: entriesToBody(body),
  });
}

export function serializeSavedGenerationRequestConfig(
  config: SavedGenerationRequestConfig,
): string {
  const baseUrl = config.baseUrl?.trim() || undefined;
  return JSON.stringify({
    version: 2,
    ...(baseUrl ? { baseUrl } : {}),
    ...normalizeProviderRequestOverrides(config),
  });
}

export function deserializeSavedGenerationRequestConfig(
  value: string,
): SavedGenerationRequestConfig {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return deserializeCustomProviderRequestConfig(value);
  }
  if (parsed.version === 2) {
    if (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string") {
      throw new Error("Invalid saved generation endpoint URL");
    }
    return {
      ...(typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? { baseUrl: parsed.baseUrl.trim() }
        : {}),
      ...normalizeProviderRequestOverrides({
        headers: parsed.headers as CustomRequestHeaders | undefined,
        body: parsed.body as CustomRequestBody | undefined,
      }),
    };
  }
  const legacy = deserializeCustomProviderRequestConfig(value);
  return legacy;
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
  const value = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function mergeJsonObjects(
  base: Record<string, unknown>,
  custom: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [name, value] of Object.entries(custom)) {
    const current = merged[name];
    merged[name] =
      current &&
      value &&
      typeof current === "object" &&
      typeof value === "object" &&
      !Array.isArray(current) &&
      !Array.isArray(value)
        ? mergeJsonObjects(
            current as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return merged;
}

function ownValueAtPath(
  value: Record<string, unknown>,
  path: string,
): { found: boolean; value?: unknown } {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, part)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function setValueAtPath(value: Record<string, unknown>, path: string, next: unknown): void {
  const parts = path.split(".");
  let current = value;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = next;
}

function deleteValueAtPath(value: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  const parents: Array<[Record<string, unknown>, string]> = [];
  let current = value;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) return;
    parents.push([current, part]);
    current = child as Record<string, unknown>;
  }
  delete current[parts.at(-1)!];
  for (const [parent, part] of parents.reverse()) {
    const child = parent[part];
    if (!child || typeof child !== "object" || Object.keys(child).length > 0) break;
    delete parent[part];
  }
}

export function mergeCustomRequestBody(
  base: Record<string, unknown>,
  customBody: CustomRequestBody | undefined,
  protectedPaths: readonly string[] = [],
): Record<string, unknown> {
  const custom = normalizeProviderRequestOverrides({ body: customBody }).body ?? {};
  const merged = mergeJsonObjects(base, custom);
  for (const path of protectedPaths) {
    const managed = ownValueAtPath(base, path);
    if (managed.found) setValueAtPath(merged, path, managed.value);
    else deleteValueAtPath(merged, path);
  }
  return merged;
}

export function mergeCustomRequestHeaders(
  base: CustomRequestHeaders,
  customHeaders: CustomRequestHeaders | undefined,
): CustomRequestHeaders {
  return {
    ...base,
    ...(normalizeProviderRequestOverrides({ headers: customHeaders }).headers ?? {}),
  };
}

export function requestOverrideSecretValues(overrides: ProviderRequestOverrides): string[] {
  const values = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && value) values.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(overrides.headers);
  collect(overrides.body);
  return [...values];
}
