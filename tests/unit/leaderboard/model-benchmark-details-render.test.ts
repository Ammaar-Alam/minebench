import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelBenchmarkDetailsInline } from "../../../components/leaderboard/ModelBenchmarkDetails";
import { MODEL_CATALOG } from "../../../lib/ai/modelCatalog";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const trackedMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "tracked-details",
    modelKey: "openai_gpt_5_6_sol",
    displayName: "GPT 5.6 Sol Pro",
    open: true,
  }),
);
assert.ok(
  trackedMarkup.includes("Parameters") &&
    trackedMarkup.includes("Statistics") &&
    trackedMarkup.includes("Output cap") &&
    trackedMarkup.includes("128,000 tokens") &&
    trackedMarkup.includes("25m 16.2s") &&
    trackedMarkup.includes("Average JSON size") &&
    trackedMarkup.includes("91.58 MiB") &&
    trackedMarkup.includes("$710.82") &&
    trackedMarkup.includes("$47.39 per build") &&
    !trackedMarkup.includes("per attempt") &&
    (trackedMarkup.match(/Not tracked/g)?.length ?? 0) === 1,
  "a model without attempt tracking should divide its cost by finalized builds",
);
assert.ok(
  trackedMarkup.includes('<h2 class="sr-only">GPT 5.6 Sol Pro run details</h2>'),
  "inline details should establish an h2 before their h3 section headings",
);

const removedEstimateMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "cost-only-details",
    modelKey: "openai_gpt_5_4",
    displayName: "GPT 5.4",
    open: true,
  }),
);
assert.ok(
  removedEstimateMarkup.includes("XHigh") &&
    removedEstimateMarkup.includes("Output cap") &&
    removedEstimateMarkup.includes("Total cost") &&
    !removedEstimateMarkup.includes("$25.00") &&
    (removedEstimateMarkup.match(/Not tracked/g)?.length ?? 0) === 3,
  "removed GPT 5.4 estimates should keep unavailable statistics compact",
);

const geminiMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "gemini-details",
    modelKey: "gemini_3_6_flash",
    displayName: "Gemini 3.6 Flash",
    open: true,
  }),
);
assert.ok(
  geminiMarkup.includes("High") &&
    geminiMarkup.includes("Average inference") &&
    geminiMarkup.includes("1m 41.9s") &&
    geminiMarkup.includes("Average JSON size") &&
    geminiMarkup.includes("Total cost") &&
    geminiMarkup.includes("$3.22"),
  "a fully tracked Gemini model should render every normalized statistic row",
);

const attemptCostSnapshots = [
  ["openai_gpt_6_astra", "GPT 6 Astra Pro", "$34.71*", "$2.31* per attempt"],
  ["meta_muse_spark_1_3", "Muse Spark 1.3", "$6.57", "$0.23 per attempt"],
  ["openai_gpt_5_6_luna", "GPT 5.6 Luna Pro", "$1.15", "$0.05 per attempt"],
  ["anthropic_claude_fable_5_1", "Claude Fable 5.1", "$147.55", "$6.42 per attempt"],
  ["gemini_3_8_flash", "Gemini 3.8 Flash", "$1.18", "$0.06 per attempt"],
  ["gemini_3_7_flash", "Gemini 3.7 Flash", "$1.46", "$0.08 per attempt"],
  ["xai_grok_4_6", "Grok 4.6", "$11.22", "$0.56 per attempt"],
  ["zai_glm_5_3_flash", "Z.AI GLM 5.3 Flash", "$0.74", "$0.02 per attempt"],
  ["qwen_qwen3_8_max", "Qwen 3.8 Max", "$11.53", "$0.29 per attempt"],
] as const;

for (const [modelKey, displayName, totalCost, averageCost] of attemptCostSnapshots) {
  const markup = renderToStaticMarkup(
    React.createElement(ModelBenchmarkDetailsInline, {
      id: `${modelKey}-details`,
      modelKey,
      displayName,
      open: true,
    }),
  );
  assert.ok(
    markup.includes(totalCost) &&
      markup.includes(averageCost) &&
      !markup.includes("per build"),
    `${displayName} should divide its cost snapshot by covered attempts`,
  );
}

const astraMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "astra-details",
    modelKey: "openai_gpt_6_astra",
    displayName: "GPT 6 Astra Pro",
    open: true,
  }),
);
assert.ok(astraMarkup.includes("* Estimated cost; the provider dashboard has not yet updated."));

const gemini30Markup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "gemini-3-0-details",
    modelKey: "gemini_3_0_flash",
    displayName: "Gemini 3.0 Flash",
    open: true,
  }),
);
assert.ok(
  gemini30Markup.includes("Output cap") &&
    gemini30Markup.includes("65,536 tokens"),
  "Gemini 3.0 Flash should render its exact provider output limit",
);

const reconstructedCaps = {
  openai_gpt_4_1: "32,768 tokens",
  openai_gpt_4o: "16,384 tokens",
  anthropic_claude_4_5_sonnet: "32,768 tokens",
  qwen_qwen3_max_thinking: "32,768 tokens",
  qwen_qwen3_5_397b_a17b: "32,768 tokens",
  gemini_3_1_pro: "65,536 tokens",
  gemini_2_5_pro: "65,536 tokens",
  gemma_4_31b: "32,768 tokens",
  moonshot_kimi_k2: "65,536 tokens",
  zai_glm_4_7: "65,536 tokens",
  minimax_m2_5: "131,072 tokens",
} as const;
for (const [modelKey, expectedCap] of Object.entries(reconstructedCaps)) {
  const markup = renderToStaticMarkup(
    React.createElement(ModelBenchmarkDetailsInline, {
      id: `${modelKey}-details`,
      modelKey,
      displayName: modelKey,
      open: true,
    }),
  );
  assert.ok(
    markup.includes(expectedCap),
    `${modelKey} should render its reconstructed accepted output cap`,
  );
}

const mixedCapExpectations = {
  anthropic_claude_4_5_opus: "8,192 or 32,768 tokens",
  anthropic_claude_4_6_sonnet: "32,768 or 64,000 tokens",
  moonshot_kimi_k2_5: "Accepted cap not recorded",
  meta_llama_4_maverick: "Accepted cap not recorded",
} as const;
for (const [modelKey, expectedCap] of Object.entries(mixedCapExpectations)) {
  const markup = renderToStaticMarkup(
    React.createElement(ModelBenchmarkDetailsInline, {
      id: `${modelKey}-details`,
      modelKey,
      displayName: modelKey,
      open: true,
    }),
  );
  assert.ok(
    markup.includes(expectedCap),
    `${modelKey} should explain its nonuniform historical output cap`,
  );
}

const untrackedMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "untracked-details",
    modelKey: "openai_gpt_4_5_web_harness",
    displayName: "GPT 4.5 (web harness)",
    open: true,
  }),
);
assert.ok(
  untrackedMarkup.includes("ChatGPT web harness") &&
    untrackedMarkup.includes("Not available from web harness") &&
    (untrackedMarkup.match(/Not tracked/g)?.length ?? 0) === 3 &&
    untrackedMarkup.includes("not directly comparable to API-generated runs"),
  "a historical web benchmark should explain missing values and keep its comparability note",
);

for (const model of MODEL_CATALOG) {
  const markup = renderToStaticMarkup(
    React.createElement(ModelBenchmarkDetailsInline, {
      id: `${model.key}-attempt-details`,
      modelKey: model.key,
      displayName: model.displayName,
      open: true,
    }),
  );
  assert.ok(
    markup.includes("Total attempts"),
    `${model.displayName} should render the normalized Total attempts statistic`,
  );
}

const opus5Markup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "opus-5-details",
    modelKey: "anthropic_claude_opus_5",
    displayName: "Claude Opus 5",
    open: true,
  }),
);
assert.ok(
  opus5Markup.includes("128,000 tokens") &&
    opus5Markup.includes("32m 10.2s") &&
    opus5Markup.includes("91.00 MiB") &&
    opus5Markup.includes("Total attempts") &&
    opus5Markup.includes(">37<") &&
    opus5Markup.includes("$89.97") &&
    opus5Markup.includes("$2.43 per attempt") &&
    !opus5Markup.includes("Not tracked"),
  "Claude Opus 5 should use the completed responses covered by its cost snapshot",
);

const exactGlmMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "exact-glm-details",
    modelKey: "zai_glm_5_1",
    displayName: "Z.AI GLM 5.1",
    open: true,
  }),
);
assert.ok(
  exactGlmMarkup.includes("17m 26s") && !exactGlmMarkup.includes("~17m 26s"),
  "the exact GLM 5.1 duration should not carry an approximation marker",
);

const exactGrokMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "exact-grok-details",
    modelKey: "xai_grok_4_20",
    displayName: "Grok 4.20",
    open: true,
  }),
);
assert.ok(
  exactGrokMarkup.includes("2m 29s") && !exactGrokMarkup.includes("~2m 29s"),
  "Grok 4.20's recorded duration should render as exact",
);

const exactOpusMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "exact-opus-details",
    modelKey: "anthropic_claude_4_7_opus",
    displayName: "Claude 4.7 Opus",
    open: true,
  }),
);
assert.ok(
  exactOpusMarkup.includes("43m 20s") &&
    !exactOpusMarkup.includes("~43m 20s") &&
    !exactOpusMarkup.includes("$275.00"),
  "Opus 4.7 should render its recorded time without an approximation marker",
);

const attemptTrackedMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "attempt-tracked-details",
    modelKey: "anthropic_claude_opus_5",
    displayName: "Claude Opus 5",
    open: true,
  }),
);
assert.ok(
  attemptTrackedMarkup.includes("$89.97") &&
    attemptTrackedMarkup.includes("$2.43 per attempt") &&
    !attemptTrackedMarkup.includes("per build") &&
    attemptTrackedMarkup.includes("37") &&
    attemptTrackedMarkup.includes("128,000 tokens") &&
    !attemptTrackedMarkup.includes("Not tracked"),
  "a priced attempt cohort should divide cost by its fixed response count",
);

console.log("model benchmark details render checks passed");
