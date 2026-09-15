import assert from "node:assert/strict";
import {
  jsonResponse,
  runGeneration,
  runProviderConfigTest,
} from "../../helpers/providerConfigHarness";

function validLargeBuildJson(): string {
  return JSON.stringify({
    version: "1.0",
    boxes: [],
    lines: [],
    blocks: Array.from({ length: 240 }, (_, index) => ({
      x: index % 10,
      y: Math.floor(index / 10) % 6,
      z: Math.floor(index / 60),
      type: "stone",
    })),
  });
}

runProviderConfigTest(
  "anthropic token-alias merge",
  { ANTHROPIC_STREAM_RESPONSES: "0", ANTHROPIC_OPUS_5_EFFORT: "max" },
  async (capture) => {
    capture.respondWith((request) => {
      if (!request.url.includes("api.anthropic.com")) return null;
      if (Object.hasOwn(request.body, "max_tokens")) {
        return jsonResponse({
          content: [{ type: "text", text: validLargeBuildJson() }],
          stop_reason: "end_turn",
        });
      }
      return jsonResponse(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "max_tokens: Input should be a valid integer. max_tokens is a required property",
          },
        },
        400,
      );
    });

    for (const wrongAlias of ["max_completion_tokens", "max_output_tokens"] as const) {
      const run = await runGeneration(capture, {
        modelKey: "anthropic_claude_opus_5",
        maxAttempts: 1,
        providerKeys: { anthropic: "test-anthropic-key" },
        customBody: { [wrongAlias]: 8192 },
      });

      assert.equal(
        run.result.ok,
        true,
        `${wrongAlias}: generation should succeed; result=${JSON.stringify(run.result)}`,
      );
      assert.equal(
        run.requests.length,
        1,
        `${wrongAlias}: a single well-formed request should be sent (no budget-ladder traversal of malformed bodies)`,
      );
      const body = run.requests[0].body;
      assert.equal(
        Object.hasOwn(body, "max_tokens"),
        true,
        `${wrongAlias}: Anthropic-required max_tokens must survive the merge`,
      );
      assert.equal(
        body.max_tokens,
        8192,
        `${wrongAlias}: max_tokens carries the user's pinned token count via the budget pipeline`,
      );
      assert.equal(
        Object.hasOwn(body, wrongAlias),
        false,
        `${wrongAlias}: user-supplied mismatched alias must not leak into the request body`,
      );
      assert.equal(
        run.result.acceptedOutputTokens,
        8192,
        `${wrongAlias}: accepted token budget should match the pinned count`,
      );
    }
  },
);
