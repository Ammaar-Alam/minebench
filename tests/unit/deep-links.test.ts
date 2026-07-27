import assert from "node:assert/strict";
import {
  buildLeaderboardBuildPath,
  buildSandboxModePath,
  buildSandboxComparisonPath,
  parseSandboxComparisonDeepLink,
  readSandboxUrlMode,
} from "../../lib/deepLinks";

assert.deepEqual(
  parseSandboxComparisonDeepLink(
    new URLSearchParams("models=model-a,model-b,model-c,model-d&promptId=prompt-1"),
  ),
  {
    modelKeys: ["model-a", "model-b", "model-c", "model-d"],
    promptId: "prompt-1",
  },
);

assert.deepEqual(
  parseSandboxComparisonDeepLink(
    new URLSearchParams("models=model-a,,model-a,model-b,model-c,model-d,model-e"),
  ),
  {
    modelKeys: ["model-a", "model-b", "model-c", "model-d"],
    promptId: null,
  },
);

assert.equal(
  buildSandboxComparisonPath(
    new URLSearchParams("prompt=old+prompt&utm_source=share"),
    ["openai/gpt-5", "anthropic/claude"],
    "prompt id",
  ),
  "/sandbox?utm_source=share&models=openai%2Fgpt-5%2Canthropic%2Fclaude&promptId=prompt+id",
);

assert.equal(
  buildSandboxComparisonPath(
    new URLSearchParams("mode=live&modelA=legacy-a&modelB=legacy-b"),
    ["model-a", "model-b"],
    null,
  ),
  "/sandbox?models=model-a%2Cmodel-b",
);

assert.deepEqual(
  parseSandboxComparisonDeepLink(
    new URL(
      buildSandboxComparisonPath(
        new URLSearchParams(),
        ["openai/gpt-5", "anthropic/claude"],
        "prompt id",
      ),
      "https://minebench.ai",
    ).searchParams,
  ),
  {
    modelKeys: ["openai/gpt-5", "anthropic/claude"],
    promptId: "prompt id",
  },
);

assert.equal(
  readSandboxUrlMode(new URLSearchParams("prompt=build+a+castle")),
  "live",
);
assert.equal(
  readSandboxUrlMode(new URLSearchParams("prompt=build+a+castle&models=model-a,model-b")),
  "benchmark",
);
assert.equal(
  buildSandboxModePath(
    new URLSearchParams("models=model-a,model-b&promptId=prompt-1&utm_source=share"),
    "live",
  ),
  "/sandbox?utm_source=share&mode=live",
);
assert.equal(
  buildSandboxModePath(
    new URLSearchParams("prompt=build+a+castle&mode=live"),
    "benchmark",
  ),
  "/sandbox",
);

assert.equal(
  buildLeaderboardBuildPath(
    "/leaderboard/model-a",
    new URLSearchParams("tab=prompts"),
    "build-1",
  ),
  "/leaderboard/model-a?tab=prompts&build=build-1",
);

assert.equal(
  buildLeaderboardBuildPath(
    "/leaderboard/model-a",
    new URLSearchParams("tab=prompts&build=build-1"),
    null,
  ),
  "/leaderboard/model-a?tab=prompts",
);

console.log("deep link checks passed");
