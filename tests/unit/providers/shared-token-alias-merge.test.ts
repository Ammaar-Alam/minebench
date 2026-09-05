import assert from "node:assert/strict";
import { postChatCompletionWithTokenBudgetRetry } from "../../../lib/ai/providers/shared";
import { tokenBudgetCandidates } from "../../../lib/ai/tokenBudgets";

const TOKEN_ALIASES = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

function minimaxLooksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    b.includes("max tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit") ||
    (b.includes("does not support") && b.includes("tokens >"))
  );
}

async function runScenario(
  buildBody: (tok: number) => Record<string, unknown>,
  customBody: Record<string, unknown> | undefined,
): Promise<{ captured: Array<Record<string, unknown>>; acceptedTokenBudget: number }> {
  const captured: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    captured.push(body);
    const present = TOKEN_ALIASES.filter((name) => Object.hasOwn(body, name));
    if (present.length > 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: `max_tokens and max_completion_tokens are mutually exclusive`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { acceptedTokenBudget } = await postChatCompletionWithTokenBudgetRetry({
      serviceLabel: "MiniMax-test",
      url: "https://api.minimax.test/v1/chat/completions",
      apiKey: "test-key",
      maxOutputTokens: 16384,
      stream: false,
      looksLikeTokenLimitError: minimaxLooksLikeTokenLimitError,
      buildBody,
      customBody,
    });
    return { captured, acceptedTokenBudget };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  const minimaxBuildBody = (tok: number) => ({
    model: "MiniMax-M2",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    stream: false,
    reasoning_split: true,
    temperature: 0.2,
    max_completion_tokens: tok,
  });

  const result = await runScenario(minimaxBuildBody, { max_tokens: 8192 });

  assert.equal(
    result.captured.length,
    1,
    "exactly one request should be sent (no token-budget ladder descent)",
  );
  const body = result.captured[0];
  assert.equal(
    Object.hasOwn(body, "max_completion_tokens"),
    false,
    "adapter token alias must be stripped when user supplies a different alias",
  );
  assert.equal(
    Object.hasOwn(body, "max_output_tokens"),
    false,
    "no other token alias should be present",
  );
  assert.equal(body.max_tokens, 8192, "user token alias should win");
  assert.equal(body.model, "MiniMax-M2");
  assert.equal(body.reasoning_split, true);
  assert.equal(result.acceptedTokenBudget, 16384);

  const sameAlias = await runScenario(minimaxBuildBody, { max_completion_tokens: 4096 });
  assert.equal(sameAlias.captured.length, 1);
  assert.equal(sameAlias.captured[0].max_completion_tokens, 4096);
  assert.equal(Object.hasOwn(sameAlias.captured[0], "max_tokens"), false);

  const deepseekBuildBody = (tok: number) => ({
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    stream: false,
    max_tokens: tok,
    thinking: { type: "enabled" },
  });
  const deepseek = await runScenario(deepseekBuildBody, { max_output_tokens: 8192 });
  assert.equal(deepseek.captured.length, 1);
  assert.equal(
    Object.hasOwn(deepseek.captured[0], "max_tokens"),
    false,
    "adapter max_tokens stripped when user sets max_output_tokens",
  );
  assert.equal(deepseek.captured[0].max_output_tokens, 8192);

  const noOverride = await runScenario(minimaxBuildBody, undefined);
  assert.equal(noOverride.captured.length, 1);
  assert.equal(noOverride.captured[0].max_completion_tokens, 16384);
  assert.equal(Object.hasOwn(noOverride.captured[0], "max_tokens"), false);

  assert.deepEqual(
    tokenBudgetCandidates(16384),
    [16384, 12288, 8192, 6144, 4096, 2048],
  );

  console.log("shared token-alias merge checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
