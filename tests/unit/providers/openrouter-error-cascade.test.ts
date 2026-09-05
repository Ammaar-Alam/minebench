import assert from "node:assert/strict";
import { openrouterGenerateText } from "../../../lib/ai/providers/openrouter";

type GenerateParams = Parameters<typeof openrouterGenerateText>[0];

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 5-effort reasoning profile: {max}, {xhigh}, {high}, __default__, undefined
// (the worst-case ladder the bug multiplied across). Keeping a jsonSchema keeps
// require_parameters=true so the request matches the real Opus structured path.
function baseProfile(): GenerateParams {
  return {
    modelId: "anthropic/claude-opus-4.8",
    apiKey: "test-openrouter-key",
    system: "Return valid JSON.",
    user: "Build a small test shape.",
    maxOutputTokens: 128000,
    temperature: 0.2,
    reasoningEffortAttempts: ["max", "xhigh", "high"],
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  };
}

function installFetchSpy(stub: (init?: RequestInit) => Response | Promise<Response>) {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return stub(init);
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function expectReject(promise: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert.match(
      (err as Error).message,
      re,
      `Expected rejection matching ${re}, got: ${(err as Error).message}`,
    );
    return;
  }
  assert.fail(`Expected rejection matching ${re}, but the promise resolved`);
}

async function main() {
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  // 1. A persistent 401 is terminal: fetchWithRetry never retries 4xx, and the
  //    unhandled-status guard must abort the reasoning-config ladder after one
  //    request instead of cascading through all 5 configs (was 5 fetches).
  {
    const fetch = installFetchSpy(() =>
      jsonResponse({ error: { message: "invalid api key" } }, 401),
    );
    console.error = () => {};
    try {
      const traces: string[] = [];
      await expectReject(
        openrouterGenerateText({ ...baseProfile(), onTrace: (m) => traces.push(m) }),
        /OpenRouter error 401/,
      );
      assert.equal(
        fetch.count(),
        1,
        "401 auth error must abort after a single fetch — it is not config-recoverable",
      );
      assert.ok(
        traces.some((t) => /unhandled HTTP 401 after retries/.test(t)),
        `expected an 'unhandled HTTP 401' trace; got ${JSON.stringify(traces)}`,
      );
    } finally {
      console.error = originalConsoleError;
      fetch.restore();
    }
  }

  // 2. A persistent 429 is terminal after fetchWithRetry's 3 internal retries,
  //    instead of 5 configs × 3 retries = 15 requests against a rate-limited account.
  {
    const fetch = installFetchSpy(() =>
      jsonResponse({ error: { message: "rate limited" } }, 429),
    );
    console.error = () => {};
    try {
      await expectReject(
        openrouterGenerateText({ ...baseProfile() }),
        /OpenRouter error 429/,
      );
      assert.equal(
        fetch.count(),
        3,
        "429 must abort after 3 internal fetchWithRetry retries, not cascade across reasoning configs",
      );
    } finally {
      console.error = originalConsoleError;
      fetch.restore();
    }
  }

  // 3. A persistent 5xx is terminal after fetchWithRetry's 3 internal retries
  //    (was 15 requests). Matches the fast-fail behavior for thrown network errors.
  {
    const fetch = installFetchSpy(() =>
      jsonResponse({ error: { message: "upstream unavailable" } }, 503),
    );
    console.error = () => {};
    try {
      await expectReject(
        openrouterGenerateText({ ...baseProfile() }),
        /OpenRouter error 503/,
      );
      assert.equal(
        fetch.count(),
        3,
        "503 must abort after 3 internal fetchWithRetry retries, not cascade across reasoning configs",
      );
    } finally {
      console.error = originalConsoleError;
      fetch.restore();
    }
  }

  // 4. No regression: a 400 reasoning-config rejection still advances to the next
  //    reasoning config (the intentional fallback path must not be made terminal).
  {
    const fetch = installFetchSpy((init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      const reasoning = body.reasoning as { effort?: string } | undefined;
      if (reasoning && reasoning.effort === "max") {
        return jsonResponse(
          { error: { message: "reasoning.effort 'max' is an unsupported enum value" } },
          400,
        );
      }
      return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }, 200);
    });
    try {
      const traces: string[] = [];
      const result = await openrouterGenerateText({
        ...baseProfile(),
        onTrace: (m) => traces.push(m),
      });
      assert.equal(result.text, '{"ok":true}');
      assert.equal(
        fetch.count(),
        2,
        "400 reasoning-config rejection must advance exactly one config, then succeed",
      );
      assert.ok(
        traces.some((t) => /reasoning config 'max' rejected/.test(t)),
        `expected a reasoning-config fallback trace; got ${JSON.stringify(traces)}`,
      );
    } finally {
      fetch.restore();
    }
  }

  // 5. No regression: a generic 400 (no matching error shape) on a multi-config
  //    model is terminal after one request, rather than cascading through configs.
  {
    const fetch = installFetchSpy(() =>
      jsonResponse({ error: { message: "invalid request" } }, 400),
    );
    console.error = () => {};
    try {
      await expectReject(
        openrouterGenerateText({ ...baseProfile() }),
        /OpenRouter error 400/,
      );
      assert.equal(
        fetch.count(),
        1,
        "generic 400 with no matching error shape must be terminal, not cascade across configs",
      );
    } finally {
      console.error = originalConsoleError;
      fetch.restore();
    }
  }

  // 6. No regression: a 400 text.verbosity rejection still retries the SAME config
  //    once with verbosity disabled (the inner while-loop `continue` path).
  {
    const fetch = installFetchSpy((init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      if (body.text) {
        return jsonResponse(
          { error: { message: "text.verbosity is an unsupported parameter" } },
          400,
        );
      }
      return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }, 200);
    });
    try {
      const result = await openrouterGenerateText({
        ...baseProfile(),
        modelId: "openai/gpt-5",
      });
      assert.equal(result.text, '{"ok":true}');
      assert.equal(
        fetch.count(),
        2,
        "verbosity rejection must retry the SAME config once with verbosity disabled",
      );
    } finally {
      fetch.restore();
    }
  }

  // 7. No regression: a thrown network error still fails fast at 3 (fetchWithRetry
  //    re-throws on the final try, bypassing the dispatch entirely).
  {
    const fetch = installFetchSpy(() => {
      throw new TypeError("fetch failed");
    });
    console.error = () => {};
    try {
      await expectReject(
        openrouterGenerateText({ ...baseProfile() }),
        /OpenRouter request failed/,
      );
      assert.equal(
        fetch.count(),
        3,
        "thrown network error must fail fast after 3 attempts, bypassing config fallback",
      );
    } finally {
      console.error = originalConsoleError;
      fetch.restore();
    }
  }

  console.log("openrouter error-cascade checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
