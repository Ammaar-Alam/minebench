import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../lib/ai/generateVoxelBuild";
import { getModelByKey, type ModelKey, type Provider } from "../../lib/ai/modelCatalog";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG } from "../../scripts/uploadsCatalog";

export type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
};

export type FetchResponder = (request: CapturedRequest) => Response | null;

export function validBuildJson(): string {
  return JSON.stringify({
    version: "1.0",
    boxes: [],
    lines: [],
    blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
  });
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function schemaContainsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => schemaContainsKey(entry, key));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, key) || Object.values(record).some((entry) => schemaContainsKey(entry, key));
}

// Default responders return a valid build for the provider's wire format so a
// generation completes after exactly one request
function defaultResponse(request: CapturedRequest): Response {
  if (request.url.includes("generativelanguage.googleapis.com")) {
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: validBuildJson() }] } }],
    });
  }
  if (request.url.includes("api.anthropic.com")) {
    return jsonResponse({
      content: [{ type: "text", text: validBuildJson() }],
      stop_reason: "end_turn",
    });
  }
  if (request.url.includes("/v1/responses")) {
    return jsonResponse({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: validBuildJson() }] }],
    });
  }
  return jsonResponse({
    choices: [{ message: { content: validBuildJson() } }],
  });
}

// Installs a fetch stub that records every outbound provider request in order.
// `respondWith` lets a scenario script rejections or provider-specific bodies;
// returning null falls through to the default success response.
export function installFetchCapture() {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  let responder: FetchResponder | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.ok(init?.body, "Provider request should include a JSON body");
    assert.equal(typeof init.body, "string", "Provider request body should be serialized JSON");

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const request: CapturedRequest = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      signal: init.signal,
    };
    requests.push(request);

    return responder?.(request) ?? defaultResponse(request);
  }) as typeof fetch;

  return {
    requests,
    respondWith(next: FetchResponder | null) {
      responder = next;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// Applies the shared provider-test env (raised output cap, test OpenRouter base
// URL) plus per-run overrides, restoring the previous values afterwards
export async function withProviderTestEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const applied: Record<string, string | undefined> = {
    MINEBENCH_MAX_OUTPUT_TOKENS: "999999",
    OPENROUTER_BASE_URL: "https://openrouter.test/api",
    ...overrides,
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(applied)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

export type ExpectedCatalogEntry = {
  key: ModelKey;
  provider: Provider;
  modelId: string;
  displayName: string;
  openRouterModelId?: string;
  slug: string;
  enabled?: boolean;
  importOnly?: boolean;
  forceOpenRouter?: boolean;
};

export function assertCatalogEntry(expected: ExpectedCatalogEntry) {
  const model = getModelByKey(expected.key);
  assert.equal(model.provider, expected.provider);
  assert.equal(model.modelId, expected.modelId);
  assert.equal(model.displayName, expected.displayName);
  assert.equal(model.enabled, expected.enabled ?? true);
  assert.equal(model.openRouterModelId, expected.openRouterModelId);
  assert.equal(model.importOnly ?? false, expected.importOnly ?? false);
  assert.equal(model.forceOpenRouter ?? false, expected.forceOpenRouter ?? false);
  assert.equal(MODEL_SLUG[expected.key], expected.slug);
  assert.equal(MODEL_KEY_BY_SLUG[expected.slug], expected.key);
  return model;
}

export type GenerationRun = {
  traces: string[];
  requests: CapturedRequest[];
  result: Awaited<ReturnType<typeof generateVoxelBuild>>;
};

// Runs one generation against the fetch capture and returns the traces plus
// the requests issued by this run alone
export async function runGeneration(
  capture: ReturnType<typeof installFetchCapture>,
  options: {
    modelKey: ModelKey;
    providerKeys: Record<string, string>;
    allowServerKeys?: boolean;
    gridSize?: 64 | 256 | 512;
    maxAttempts?: number;
    enableTools?: boolean;
    prompt?: string;
    reasoning?: string;
    preferOpenRouter?: boolean;
  },
): Promise<GenerationRun> {
  const traces: string[] = [];
  const start = capture.requests.length;
  const result = await generateVoxelBuild({
    modelKey: options.modelKey,
    prompt: options.prompt ?? "small tower",
    gridSize: options.gridSize ?? 64,
    palette: "simple",
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    enableTools: options.enableTools ?? false,
    providerKeys: options.providerKeys,
    allowServerKeys: options.allowServerKeys ?? false,
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    ...(options.preferOpenRouter !== undefined
      ? { preferOpenRouter: options.preferOpenRouter }
      : {}),
    onProviderTrace: (message: string) => traces.push(message),
  });
  return { traces, requests: capture.requests.slice(start), result };
}

export function assertTraceLine(
  traces: string[],
  fragments: string[],
  message: string,
  absentFragments: string[] = [],
) {
  assert.ok(
    traces.some(
      (trace) =>
        fragments.every((fragment) => trace.includes(fragment)) &&
        absentFragments.every((fragment) => !trace.includes(fragment)),
    ),
    `${message}\ntraces:\n${traces.join("\n")}`,
  );
}

// Standard runner wrapper: installs capture + env, restores both, and exits
// nonzero on failure so tests/run.ts reports the file correctly
export function runProviderConfigTest(
  name: string,
  env: Record<string, string | undefined>,
  main: (capture: ReturnType<typeof installFetchCapture>) => Promise<void>,
) {
  const capture = installFetchCapture();
  withProviderTestEnv(env, () => main(capture))
    .then(() => {
      console.log(`${name} config checks passed`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      capture.restore();
    });
}
