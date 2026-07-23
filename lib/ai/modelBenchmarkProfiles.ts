import type { ModelKey } from "@/lib/ai/modelCatalog";
import generatedMetrics from "@/lib/ai/modelBenchmarkMetrics.generated.json";

export type ModelRunParameter = {
  label: string;
  value: string;
};

export type ModelRunParameters = readonly [ModelRunParameter, ...ModelRunParameter[]];

export type BenchmarkDuration = {
  milliseconds: number;
};

export type BenchmarkCost = {
  usd: number;
};

export type BenchmarkOutputCap =
  | {
      kind: "exact";
      tokens: number;
    }
  | {
      kind: "variants";
      tokens: readonly [number, number, ...number[]];
    }
  | {
      kind: "unavailable";
      reason:
        | "accepted-cap-unrecorded"
        | "predates-tracking"
        | "varied-across-builds"
        | "web-harness-unavailable";
    };

export type ModelBenchmarkProfile = {
  sourceRelease?: string;
  parameters: ModelRunParameters;
  outputCap: BenchmarkOutputCap;
  averageInference?: BenchmarkDuration;
  averageJsonSizeBytes?: number;
  totalCost?: BenchmarkCost;
  buildCount?: number;
  note?: string;
};

const OPENAI_XHIGH_128K: ModelRunParameters = [
  { label: "Reasoning effort", value: "XHigh" },
];

const OPENAI_XHIGH_HIGH_128K: ModelRunParameters = [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Text verbosity", value: "High" },
];

const PROVIDER_DEFAULT: ModelRunParameters = [
  { label: "Reasoning", value: "Provider default" },
];

const ANTHROPIC_LEGACY_THINKING: ModelRunParameters = [
  { label: "Thinking", value: "Extended" },
  { label: "Thinking budget", value: "65,535 tokens" },
];

const GEMINI_HIGH: ModelRunParameters = [
  { label: "Thinking level", value: "High" },
];

const OPENROUTER_XHIGH: ModelRunParameters = [
  { label: "Reasoning effort", value: "XHigh" },
];

const MODEL_RUN_PARAMETERS = {
  openai_gpt_5_6_sol: [
    { label: "Reasoning mode", value: "Pro" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Text verbosity", value: "High" },
  ],
  openai_gpt_5_5: [
    { label: "Reasoning effort", value: "Max" },
    { label: "Text verbosity", value: "High" },
  ],
  openai_gpt_5_5_pro: [
    { label: "Reasoning effort", value: "Max" },
    { label: "Text verbosity", value: "High" },
  ],
  openai_gpt_5_4: OPENAI_XHIGH_HIGH_128K,
  openai_gpt_5_4_pro: OPENAI_XHIGH_HIGH_128K,
  openai_gpt_5_4_mini: OPENAI_XHIGH_HIGH_128K,
  openai_gpt_5_4_nano: OPENAI_XHIGH_HIGH_128K,
  openai_gpt_5_3_codex: OPENAI_XHIGH_128K,
  openai_gpt_5_2: OPENAI_XHIGH_128K,
  openai_gpt_5_2_pro: OPENAI_XHIGH_128K,
  openai_gpt_5_2_codex: OPENAI_XHIGH_128K,
  openai_gpt_5_mini: OPENAI_XHIGH_128K,
  openai_gpt_5_nano: OPENAI_XHIGH_128K,
  openai_gpt_4_1: PROVIDER_DEFAULT,
  openai_gpt_4_5_web_harness: [{ label: "Source", value: "ChatGPT web harness" }],
  openai_gpt_4o: PROVIDER_DEFAULT,
  openai_gpt_oss_120b: [
    { label: "Reasoning effort", value: "XHigh" },
  ],
  anthropic_claude_fable_5: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Sampling", value: "Provider default" },
  ],
  anthropic_claude_sonnet_5: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "XHigh" },
  ],
  anthropic_claude_4_5_sonnet: ANTHROPIC_LEGACY_THINKING,
  anthropic_claude_4_6_sonnet: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
  ],
  anthropic_claude_4_5_opus: ANTHROPIC_LEGACY_THINKING,
  anthropic_claude_4_6_opus: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
  ],
  anthropic_claude_4_7_opus: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
  ],
  anthropic_claude_4_8_opus: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
  ],
  gemini_3_6_flash: [
    { label: "Thinking level", value: "High" },
    { label: "Sampling", value: "Provider default" },
  ],
  gemini_3_5_flash_lite: [
    { label: "Thinking level", value: "High" },
    { label: "Sampling", value: "Provider default" },
  ],
  gemini_3_5_flash: [
    { label: "Thinking level", value: "High" },
  ],
  gemini_3_0_pro: GEMINI_HIGH,
  gemini_3_1_pro: GEMINI_HIGH,
  gemini_3_0_flash: GEMINI_HIGH,
  gemini_3_1_flash_lite: GEMINI_HIGH,
  gemini_2_5_pro: [{ label: "Thinking", value: "Dynamic" }],
  gemma_4_31b: GEMINI_HIGH,
  moonshot_kimi_k3: [
    { label: "Reasoning effort", value: "Max" },
    { label: "Structured output", value: "Strict" },
  ],
  moonshot_kimi_k2: [{ label: "Reasoning", value: "Model default" }],
  moonshot_kimi_k2_6: [{ label: "Reasoning", value: "Thinking enabled" }],
  moonshot_kimi_k2_5: [{ label: "Reasoning", value: "Thinking enabled" }],
  deepseek_v4_pro: [
    { label: "Thinking", value: "Enabled" },
    { label: "Reasoning effort", value: "Max" },
  ],
  deepseek_v3_2: [
    { label: "Reasoning", value: "Provider default" },
  ],
  xai_grok_4_5: [
    { label: "Reasoning effort", value: "High" },
  ],
  xai_grok_4_3: [
    { label: "Reasoning", value: "Automatic" },
  ],
  xai_grok_4_1: [
    { label: "Reasoning", value: "Automatic" },
  ],
  xai_grok_4_20: [{ label: "Reasoning", value: "Thinking enabled" }],
  zai_glm_5_2: [
    { label: "Reasoning effort", value: "XHigh → High" },
  ],
  zai_glm_5_1: [
    { label: "Reasoning", value: "Thinking enabled" },
  ],
  zai_glm_5: [
    { label: "Reasoning effort", value: "XHigh" },
  ],
  zai_glm_4_7: PROVIDER_DEFAULT,
  qwen_qwen3_max_thinking: OPENROUTER_XHIGH,
  qwen_qwen3_5_397b_a17b: OPENROUTER_XHIGH,
  minimax_m2_7: [
    { label: "Reasoning effort", value: "XHigh" },
  ],
  minimax_m2_5: [
    { label: "Reasoning effort", value: "XHigh" },
  ],
  meta_llama_4_maverick: PROVIDER_DEFAULT,
} satisfies Record<ModelKey, ModelRunParameters>;

const exactOutputCap = (tokens: number): BenchmarkOutputCap => ({
  kind: "exact",
  tokens,
});

// Historical fallback values describe accepted caps, never requested-only budgets.
export const HISTORICAL_BENCHMARK_OUTPUT_CAPS: Partial<
  Record<ModelKey, BenchmarkOutputCap>
> = {
  openai_gpt_5_6_sol: exactOutputCap(128_000),
  openai_gpt_5_5: exactOutputCap(128_000),
  openai_gpt_5_5_pro: exactOutputCap(128_000),
  openai_gpt_5_4: exactOutputCap(128_000),
  openai_gpt_5_4_pro: exactOutputCap(128_000),
  openai_gpt_5_4_mini: exactOutputCap(128_000),
  openai_gpt_5_4_nano: exactOutputCap(128_000),
  openai_gpt_5_3_codex: exactOutputCap(128_000),
  openai_gpt_5_2: exactOutputCap(128_000),
  openai_gpt_5_2_pro: exactOutputCap(128_000),
  openai_gpt_5_2_codex: exactOutputCap(128_000),
  openai_gpt_5_mini: exactOutputCap(128_000),
  openai_gpt_5_nano: exactOutputCap(128_000),
  openai_gpt_4_1: exactOutputCap(32_768),
  openai_gpt_4o: exactOutputCap(16_384),
  openai_gpt_oss_120b: exactOutputCap(131_072),
  anthropic_claude_fable_5: exactOutputCap(128_000),
  anthropic_claude_sonnet_5: exactOutputCap(128_000),
  anthropic_claude_4_5_sonnet: exactOutputCap(32_768),
  anthropic_claude_4_6_sonnet: {
    kind: "variants",
    tokens: [32_768, 64_000],
  },
  anthropic_claude_4_5_opus: {
    kind: "variants",
    tokens: [8_192, 32_768],
  },
  anthropic_claude_4_6_opus: exactOutputCap(131_072),
  anthropic_claude_4_7_opus: exactOutputCap(128_000),
  anthropic_claude_4_8_opus: exactOutputCap(128_000),
  gemini_3_6_flash: exactOutputCap(65_536),
  gemini_3_5_flash_lite: exactOutputCap(65_536),
  gemini_3_5_flash: exactOutputCap(65_536),
  gemini_3_1_pro: exactOutputCap(65_536),
  gemini_3_0_flash: exactOutputCap(65_536),
  gemini_2_5_pro: exactOutputCap(65_536),
  gemma_4_31b: exactOutputCap(32_768),
  moonshot_kimi_k3: exactOutputCap(1_048_576),
  moonshot_kimi_k2: exactOutputCap(65_536),
  moonshot_kimi_k2_5: {
    kind: "unavailable",
    reason: "accepted-cap-unrecorded",
  },
  deepseek_v3_2: exactOutputCap(65_536),
  xai_grok_4_5: exactOutputCap(262_144),
  xai_grok_4_3: exactOutputCap(983_040),
  xai_grok_4_1: exactOutputCap(30_000),
  zai_glm_5_2: exactOutputCap(131_072),
  zai_glm_5_1: exactOutputCap(131_072),
  zai_glm_5: exactOutputCap(131_072),
  zai_glm_4_7: exactOutputCap(65_536),
  qwen_qwen3_max_thinking: exactOutputCap(32_768),
  qwen_qwen3_5_397b_a17b: exactOutputCap(32_768),
  minimax_m2_7: exactOutputCap(131_072),
  minimax_m2_5: exactOutputCap(131_072),
  meta_llama_4_maverick: {
    kind: "unavailable",
    reason: "accepted-cap-unrecorded",
  },
  openai_gpt_4_5_web_harness: {
    kind: "unavailable",
    reason: "web-harness-unavailable",
  },
};

const MODEL_BENCHMARK_METADATA: Partial<
  Record<ModelKey, Omit<ModelBenchmarkProfile, "outputCap" | "parameters">>
> = {
  openai_gpt_5_6_sol: {
    sourceRelease: "3.9.0",
    averageInference: { milliseconds: 1_516_200 },
    totalCost: { usd: 710.82 },
    buildCount: 15,
  },
  xai_grok_4_5: {
    sourceRelease: "3.9.0",
    averageInference: { milliseconds: 108_200 },
    totalCost: { usd: 1.69 },
    buildCount: 15,
  },
  zai_glm_5_2: {
    sourceRelease: "3.8.0",
    averageInference: { milliseconds: 381_100 },
    totalCost: { usd: 4.46 },
    buildCount: 15,
  },
  anthropic_claude_sonnet_5: {
    sourceRelease: "3.8.0",
    averageInference: { milliseconds: 1_863_100 },
    totalCost: { usd: 94.17 },
    buildCount: 15,
  },
  openai_gpt_4_5_web_harness: {
    sourceRelease: "3.8.0",
    note: "Imported from the web harness; not directly comparable to API-generated runs.",
  },
  anthropic_claude_fable_5: {
    sourceRelease: "3.7.0",
    averageInference: { milliseconds: 1_084_400 },
    totalCost: { usd: 54.93 },
    buildCount: 15,
  },
  anthropic_claude_4_8_opus: {
    sourceRelease: "3.6.0",
    averageInference: { milliseconds: 1_487_900 },
    totalCost: { usd: 41.52 },
    buildCount: 15,
  },
  gemini_3_6_flash: {
    sourceRelease: "3.10.0",
    averageInference: { milliseconds: 101_900 },
    totalCost: { usd: 2.84 },
    buildCount: 15,
  },
  gemini_3_5_flash_lite: {
    sourceRelease: "3.10.0",
    averageInference: { milliseconds: 25_700 },
    totalCost: { usd: 0.38 },
    buildCount: 15,
  },
  gemini_3_5_flash: {
    sourceRelease: "3.6.0",
    averageInference: { milliseconds: 114_100 },
    totalCost: { usd: 12.9 },
    buildCount: 15,
  },
  xai_grok_4_3: {
    sourceRelease: "3.4.0",
    averageInference: { milliseconds: 223_100 },
    totalCost: { usd: 0.87 },
  },
  xai_grok_4_20: {
    sourceRelease: "v3.0.0",
    averageInference: { milliseconds: 149_000 },
    totalCost: { usd: 18.44 },
    buildCount: 15,
  },
  openai_gpt_5_5: {
    sourceRelease: "3.3.2",
    averageInference: { milliseconds: 624_000 },
    totalCost: { usd: 19.98 },
  },
  openai_gpt_5_5_pro: {
    sourceRelease: "3.3.2",
    averageInference: { milliseconds: 1_283_300 },
    totalCost: { usd: 223.9 },
  },
  openai_gpt_5_4_pro: {
    averageInference: { milliseconds: 3_360_000 },
    totalCost: { usd: 435 },
  },
  deepseek_v4_pro: {
    sourceRelease: "3.3.2",
    totalCost: { usd: 3.92 },
  },
  anthropic_claude_4_7_opus: {
    sourceRelease: "v3.0.0",
    averageInference: { milliseconds: 2_600_000 },
  },
  zai_glm_5_1: {
    sourceRelease: "v3.0.0",
    averageInference: { milliseconds: 1_046_000 },
    totalCost: { usd: 4.18 },
    buildCount: 15,
  },
  moonshot_kimi_k2_6: {
    sourceRelease: "v3.0.0",
    totalCost: { usd: 2.35 },
  },
  moonshot_kimi_k3: {
    sourceRelease: "3.10.0",
    averageInference: { milliseconds: 1_966_000 },
    totalCost: { usd: 12.7 },
    buildCount: 15,
  },
};

export type GeneratedModelBenchmarkMetrics = {
  expectedBuildCount: number;
  finalizedBuildCount: number;
  inferenceSampleCount: number;
  averageInferenceMs?: number;
  averageJsonSizeBytes?: number;
  outputCapTokens?: number;
  outputCapSampleCount?: number;
  outputCapIsConsistent?: boolean;
  configurationSampleCount?: number;
  configurationIsConsistent?: boolean;
};

const GENERATED_MODEL_METRICS = generatedMetrics.models as Partial<
  Record<ModelKey, GeneratedModelBenchmarkMetrics>
>;

export function resolveBenchmarkOutputCap(
  modelKey: ModelKey,
  generated?: GeneratedModelBenchmarkMetrics,
): BenchmarkOutputCap {
  const generatedOutputCapCohortIsComplete =
    generated &&
    generated.expectedBuildCount > 0 &&
    generated.outputCapSampleCount === generated.expectedBuildCount;

  if (generatedOutputCapCohortIsComplete) {
    if (generated.outputCapIsConsistent && generated.outputCapTokens !== undefined) {
      return exactOutputCap(generated.outputCapTokens);
    }
    return {
      kind: "unavailable",
      reason: "varied-across-builds",
    };
  }

  const generatedConfigurationCohortIsComplete =
    generated &&
    generated.expectedBuildCount > 0 &&
    generated.configurationSampleCount === generated.expectedBuildCount;
  if (generatedConfigurationCohortIsComplete) {
    return {
      kind: "unavailable",
      reason: "accepted-cap-unrecorded",
    };
  }

  return (
    HISTORICAL_BENCHMARK_OUTPUT_CAPS[modelKey] ?? {
      kind: "unavailable",
      reason: "predates-tracking",
    }
  );
}

export const MODEL_BENCHMARK_PROFILES = Object.fromEntries(
  (Object.entries(MODEL_RUN_PARAMETERS) as [ModelKey, ModelRunParameters][]).map(
    ([modelKey, parameters]) => {
      const generated = GENERATED_MODEL_METRICS[modelKey];
      const metadata = MODEL_BENCHMARK_METADATA[modelKey];
      const generatedIsComplete =
        generated && generated.finalizedBuildCount === generated.expectedBuildCount;
      const generatedTimingCohortIsComplete =
        generated &&
        generated.expectedBuildCount > 0 &&
        generated.inferenceSampleCount === generated.expectedBuildCount;

      return [
        modelKey,
        {
          parameters,
          ...metadata,
          outputCap: resolveBenchmarkOutputCap(modelKey, generated),
          averageInference:
            generatedTimingCohortIsComplete
              ? generated.averageInferenceMs === undefined
                ? undefined
                : { milliseconds: generated.averageInferenceMs }
              : metadata?.averageInference,
          averageJsonSizeBytes:
            generatedIsComplete ? generated.averageJsonSizeBytes : undefined,
          buildCount:
            generatedIsComplete ? generated.finalizedBuildCount : metadata?.buildCount,
        },
      ];
    },
  ),
) as Record<ModelKey, ModelBenchmarkProfile>;

export function getModelBenchmarkProfile(modelKey: string): ModelBenchmarkProfile | null {
  return MODEL_BENCHMARK_PROFILES[modelKey as ModelKey] ?? null;
}
