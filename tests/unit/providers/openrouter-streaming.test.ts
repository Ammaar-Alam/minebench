import assert from "node:assert/strict";
import { openrouterGenerateText } from "../../../lib/ai/providers/openrouter";

const originalFetch = globalThis.fetch;

async function main() {
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  // 1. Verify stream: true is sent and SSE stream is accumulated without onDelta
  {
    let capturedBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;

      const ssePayload = [
        ": OPENROUTER PROCESSING\n\n",
        'data: {"choices":[{"delta":{"content":"{\\"version\\":\\""}}]}\n\n',
        ": OPENROUTER PROCESSING\n\n",
        'data: {"choices":[{"delta":{"content":"1.0\\",\\"blocks\\":[]}"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      return new Response(ssePayload, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const result = await openrouterGenerateText({
        modelId: "openai/gpt-6-astra-pro",
        apiKey: "test-openrouter-key",
        system: "Return JSON.",
        user: "Build a shrine.",
      });

      assert.equal(capturedBody?.stream, true, "OpenRouter request should have stream: true");
      assert.equal(
        result.text,
        '{"version":"1.0","blocks":[]}',
        "Should accumulate SSE chunks into full text even when onDelta is omitted",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 2. Verify mid-stream error raises cleanly
  {
    globalThis.fetch = (async (): Promise<Response> => {
      const ssePayload = [
        'data: {"error":{"message":"Rate limit reached while streaming"}}\n\n',
      ].join("");

      return new Response(ssePayload, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        openrouterGenerateText({
          modelId: "openai/gpt-6-astra-pro",
          apiKey: "test-openrouter-key",
          system: "Return JSON.",
          user: "Build a shrine.",
        }),
        /OpenRouter stream error: Rate limit reached while streaming/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log("openrouter streaming checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
