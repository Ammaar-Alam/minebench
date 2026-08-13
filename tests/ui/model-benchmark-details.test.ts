import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelBenchmarkDetailsInline } from "../../components/leaderboard/ModelBenchmarkDetails";
import { MODEL_CATALOG } from "../../lib/ai/modelCatalog";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const detailsSource = readFileSync(
  "components/leaderboard/ModelBenchmarkDetails.tsx",
  "utf8",
);
const leaderboardSource = readFileSync("components/leaderboard/Leaderboard.tsx", "utf8");
const modelDetailSource = readFileSync("components/leaderboard/ModelDetail.tsx", "utf8");

assert.ok(
  detailsSource.includes("aria-expanded={expanded}") &&
    detailsSource.includes("aria-controls={controlsId}") &&
    detailsSource.includes('aria-label={`View ${displayName} run details`}'),
  "model details trigger should expose its disclosure state and accessible name",
);
assert.ok(
  detailsSource.includes('role="region"') &&
    !detailsSource.includes('aria-modal="true"') &&
    !detailsSource.includes("backdrop-blur") &&
    !detailsSource.includes("fixed inset-0"),
  "model run details should use a nonmodal region without a full-screen backdrop",
);
assert.ok(
  detailsSource.includes("h-6 w-6") &&
    detailsSource.includes("before:-inset-y-2.5") &&
    detailsSource.includes("before:-left-1 before:-right-4") &&
    detailsSource.includes("h-[15px] w-[15px]"),
  "the quiet info glyph should retain a 44px touch target without widening its layout box",
);
assert.ok(
  detailsSource.includes('document.addEventListener("pointerdown"') &&
    detailsSource.includes('event.key === "Escape"') &&
    detailsSource.includes("event.stopPropagation()") &&
    !detailsSource.includes("onKeyDown={(event) => event.stopPropagation()}"),
  "the desktop popover should dismiss cleanly without activating its leaderboard row",
);
assert.ok(
  detailsSource.includes('document.addEventListener("scroll", handleScroll, true)') &&
    detailsSource.includes("panelRef.current?.contains(target)") &&
    !detailsSource.includes('window.addEventListener("scroll", updatePosition, true)'),
  "leaderboard scrolling should dismiss the popover while preserving its own internal scroll",
);
assert.ok(
  detailsSource.includes('placement: "above" | "below"') &&
    detailsSource.includes("style={{ left: position.arrowLeft }}") &&
    detailsSource.includes('aria-hidden="true"'),
  "the popover should render a placement-aware pointer aligned with its trigger",
);
assert.ok(
  detailsSource.includes("const POPOVER_GAP = 4") &&
    detailsSource.includes("fixed z-30 overflow-visible") &&
    detailsSource.includes("max-h-[calc(100dvh-2rem)] overflow-y-auto") &&
    detailsSource.includes("rounded-[inherit] p-3"),
  "the anchored shell should expose its pointer while an inner viewport owns overflow",
);
assert.ok(
  detailsSource.includes("setPosition(null);") &&
    detailsSource.includes("setOpen(true);") &&
    !detailsSource.includes("if (!open) updatePosition();") &&
    detailsSource.includes(
      'position ? "opacity-100" : "pointer-events-none opacity-0"',
    ),
  "the popover should stay hidden until its mounted height is measured",
);
assert.ok(
  detailsSource.includes('label: "Average inference time"') &&
    detailsSource.includes('label: "Average JSON size"') &&
    detailsSource.includes('label: "Total attempts"') &&
    detailsSource.includes('label: "Total cost"') &&
    detailsSource.includes('label: "Output cap"') &&
    detailsSource.includes('const NOT_TRACKED = "Not tracked"') &&
    !detailsSource.includes('"Benchmark predates tracking"'),
  "every normalized field should use the compact untracked fallback",
);
assert.ok(
  detailsSource.includes("profile.totalCost.usd / profile.totalCost.attemptCount") &&
    detailsSource.includes("profile.totalCost.usd / profile.buildCount") &&
    detailsSource.includes('toFixed(2)} per attempt`') &&
    detailsSource.includes('toFixed(2)} per build`') &&
    !detailsSource.includes("profile.totalCost.usd / profile.totalAttempts") &&
    !detailsSource.includes("totalCost.usd / 15"),
  "cost details should use the fixed denominator measured with each cost snapshot",
);
assert.ok(
  detailsSource.includes('v{profile.sourceRelease.replace(/^v/, "")}') &&
    !detailsSource.toLowerCase().includes("draft"),
  "the release header should render canonical profile versions without workflow-state copy",
);
assert.ok(
  detailsSource.indexOf(">\n          Statistics\n        </h3>") <
    detailsSource.indexOf(">\n          Parameters\n        </h3>") &&
    detailsSource.includes('<h2 className="sr-only">{displayName} run details</h2>') &&
    detailsSource.includes("<DetailRows rows={parameters} />") &&
    detailsSource.includes("<StatisticGrid rows={statistics} />"),
  "benchmark statistics should lead the compact summary before run parameters",
);
assert.ok(
  detailsSource.includes("Average inference") &&
    detailsSource.includes("Average JSON size") &&
    detailsSource.includes("Total attempts") &&
    detailsSource.includes("Total cost") &&
    !detailsSource.includes("statistics.length > 0"),
  "the statistics section should always render the same normalized rows",
);
assert.ok(
  !detailsSource.includes('label: "Run size"') && !detailsSource.includes("Avg."),
  "benchmark tables should use the full, specific statistic labels",
);
assert.ok(
  detailsSource.includes('className="mt-1 grid grid-cols-2 border-y border-border/60"') &&
    detailsSource.includes(
      'className="min-w-0 border-border/60 py-2 odd:pr-3 even:border-l even:pl-3 [&:nth-child(-n+2)]:border-b"',
    ) &&
    detailsSource.includes('className="mt-1 divide-y divide-border/60"') &&
    !detailsSource.includes("divide-y divide-border/60 border-y") &&
    detailsSource.includes(
      'className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3 py-2 text-[12px] leading-4"',
    ) &&
    detailsSource.includes(
      'className="group relative inline-block cursor-help border-b border-dotted border-current text-muted transition-colors hover:text-fg focus-visible:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"',
    ) &&
    !detailsSource.includes("borderBottom:") &&
    detailsSource.includes("duration-75 group-hover:opacity-100 group-focus-visible:opacity-100") &&
    detailsSource.includes('<dt className="text-muted">{row.label}</dt>') &&
    !detailsSource.includes('<dt className="text-muted2">{row.label}</dt>') &&
    detailsSource.includes('className="shrink-0 font-mono text-[10px] text-muted"') &&
    detailsSource.includes("shadow-soft") &&
    !detailsSource.includes("rgba(0,0,0"),
  "details should use compact statistics, readable parameters, and the shared shadow token",
);
assert.equal(
  detailsSource.match(
    /text-\[10px\] font-medium uppercase tracking-\[0\.12em\] text-muted/g,
  )?.length,
  2,
  "both section headings should use the compact metadata treatment",
);
assert.ok(
  leaderboardSource.includes("<ModelBenchmarkDetailsTrigger") &&
    leaderboardSource.includes("<ModelBenchmarkDetailsInline") &&
    leaderboardSource.includes("<ModelBenchmarkDetails") &&
    modelDetailSource.includes("<ModelBenchmarkDetails"),
  "mobile leaderboard cards should expand inline while desktop and model profiles expose the popover",
);
assert.ok(
  (leaderboardSource.match(/onClick=\{\(\) => navigateToModel\(m\.key\)\}/g)?.length ??
    0) === 2 &&
    leaderboardSource.includes("event.stopPropagation();") &&
    leaderboardSource.includes('aria-label={`Open ${m.displayName} profile`}'),
  "leaderboard rows and cards should navigate by pointer while preserving isolated accessible controls",
);
assert.ok(
  !detailsSource.includes("Run setup") &&
    !detailsSource.includes("Benchmark run") &&
    !detailsSource.includes("Run details") &&
    !detailsSource.includes("Ratings reflect the current prompt set"),
  "the details hierarchy should keep concise, user-facing labels",
);
assert.ok(
  leaderboardSource.includes('const LEADERBOARD_CACHE_KEY = "mb-leaderboard-v4"'),
  "the canonical model-name change should invalidate stale client leaderboard data",
);

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
    trackedMarkup.includes("border-dotted") &&
    !trackedMarkup.includes("title=") &&
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

const lunaMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "gpt-5-6-luna-details",
    modelKey: "openai_gpt_5_6_luna",
    displayName: "GPT 5.6 Luna Pro",
    open: true,
  }),
);
assert.ok(
  lunaMarkup.includes("$1.15") && lunaMarkup.includes("$0.08 per build"),
  "GPT 5.6 Luna Pro should render its canonical benchmark total and finalized-build rate",
);

const qwenMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "qwen-details",
    modelKey: "qwen_qwen3_8_max",
    displayName: "Qwen 3.8 Max",
    open: true,
  }),
);
assert.ok(
  qwenMarkup.includes("$11.53") && qwenMarkup.includes("$0.77 per build"),
  "Qwen 3.8 Max should render its canonical benchmark total and finalized-build rate",
);

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

console.log("model benchmark details UI checks passed");
