import type { ModelKey } from "@/lib/ai/modelCatalog";

export type ModelRunParameter = {
  label: string;
  value: string;
};

export type ModelRunParameters = readonly [ModelRunParameter, ...ModelRunParameter[]];

export type ModelBenchmarkProfile = {
  sourceRelease?: string;
  parameters: ModelRunParameters;
  averageInferenceTime?: string;
  totalCost?: string;
  buildCount?: number;
  note?: string;
};

const OPENAI_XHIGH_128K: ModelRunParameters = [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Output cap", value: "128,000 tokens" },
];

const OPENAI_XHIGH_HIGH_128K: ModelRunParameters = [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Text verbosity", value: "High" },
  { label: "Output cap", value: "128,000 tokens" },
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

const OPENROUTER_XHIGH_32K: ModelRunParameters = [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Requested output budget", value: "32,768 tokens" },
];

const MODEL_RUN_PARAMETERS = {
  openai_gpt_5_6_sol: [
    { label: "Reasoning mode", value: "Pro" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Text verbosity", value: "High" },
    { label: "Combined reasoning/output cap", value: "128,000 tokens" },
  ],
  openai_gpt_5_5: [
    { label: "Reasoning effort", value: "Max" },
    { label: "Text verbosity", value: "High" },
    { label: "Output cap", value: "128,000 tokens" },
  ],
  openai_gpt_5_5_pro: [
    { label: "Reasoning effort", value: "Max" },
    { label: "Text verbosity", value: "High" },
    { label: "Output cap", value: "128,000 tokens" },
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
    { label: "Combined reasoning/output budget", value: "131,072 tokens" },
  ],
  anthropic_claude_fable_5: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Sampling", value: "Provider default" },
    { label: "Output cap", value: "128,000 tokens" },
  ],
  anthropic_claude_sonnet_5: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "XHigh" },
    { label: "Output cap", value: "128,000 tokens" },
  ],
  anthropic_claude_4_5_sonnet: ANTHROPIC_LEGACY_THINKING,
  anthropic_claude_4_6_sonnet: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Requested output budget", value: "65,536 tokens" },
  ],
  anthropic_claude_4_5_opus: ANTHROPIC_LEGACY_THINKING,
  anthropic_claude_4_6_opus: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Output cap", value: "131,072 tokens" },
  ],
  anthropic_claude_4_7_opus: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Output cap", value: "128,000 tokens" },
  ],
  anthropic_claude_4_8_opus: [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Output cap", value: "128,000 tokens" },
  ],
  gemini_3_6_flash: [
    { label: "Thinking level", value: "High" },
    { label: "Sampling", value: "Provider default" },
    { label: "Output cap", value: "65,536 tokens" },
  ],
  gemini_3_5_flash_lite: [
    { label: "Thinking level", value: "High" },
    { label: "Sampling", value: "Provider default" },
    { label: "Output cap", value: "65,536 tokens" },
  ],
  gemini_3_5_flash: [
    { label: "Thinking level", value: "High" },
    { label: "Output cap", value: "65,536 tokens" },
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
    { label: "Completion ceiling", value: "1,048,576 tokens" },
  ],
  moonshot_kimi_k2: [{ label: "Reasoning", value: "Model default" }],
  moonshot_kimi_k2_6: [{ label: "Reasoning", value: "Thinking enabled" }],
  moonshot_kimi_k2_5: [{ label: "Reasoning", value: "Thinking enabled" }],
  deepseek_v4_pro: [
    { label: "Thinking", value: "Enabled" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Requested output budget", value: "384,000 tokens" },
  ],
  deepseek_v3_2: [
    { label: "Reasoning", value: "Provider default" },
    { label: "Output cap", value: "65,536 tokens" },
  ],
  xai_grok_4_5: [
    { label: "Reasoning effort", value: "High" },
    { label: "Requested output budget", value: "500,000 tokens" },
    { label: "Accepted output budget", value: "262,144 tokens" },
  ],
  xai_grok_4_3: [
    { label: "Reasoning", value: "Automatic" },
    { label: "Requested output budget", value: "1,000,000 tokens" },
    { label: "Accepted output budget", value: "983,040 tokens" },
  ],
  xai_grok_4_1: [
    { label: "Reasoning", value: "Automatic" },
    { label: "Output cap", value: "30,000 tokens" },
  ],
  xai_grok_4_20: [{ label: "Reasoning", value: "Thinking enabled" }],
  zai_glm_5_2: [
    { label: "Reasoning effort", value: "XHigh → High" },
    { label: "Output cap", value: "131,072 tokens" },
  ],
  zai_glm_5_1: [
    { label: "Reasoning", value: "Thinking enabled" },
    { label: "Output cap", value: "131,072 tokens" },
  ],
  zai_glm_5: [
    { label: "Reasoning effort", value: "XHigh" },
    { label: "Output cap", value: "131,072 tokens" },
  ],
  zai_glm_4_7: PROVIDER_DEFAULT,
  qwen_qwen3_max_thinking: OPENROUTER_XHIGH_32K,
  qwen_qwen3_5_397b_a17b: OPENROUTER_XHIGH_32K,
  minimax_m2_7: [
    { label: "Reasoning effort", value: "XHigh" },
    { label: "Output cap", value: "131,072 tokens" },
  ],
  minimax_m2_5: [
    { label: "Reasoning effort", value: "XHigh" },
    { label: "Requested output budget", value: "131,072 tokens" },
  ],
  meta_llama_4_maverick: PROVIDER_DEFAULT,
} satisfies Record<ModelKey, ModelRunParameters>;

const MODEL_BENCHMARK_METADATA: Partial<
  Record<ModelKey, Omit<ModelBenchmarkProfile, "parameters">>
> = {
  openai_gpt_5_6_sol: {
    sourceRelease: "3.9.0",
    averageInferenceTime: "25m 16.2s (1,516.2s)",
    totalCost: "$710.82",
    buildCount: 15,
  },
  xai_grok_4_5: {
    sourceRelease: "3.9.0",
    averageInferenceTime: "1m 48s (108.2s)",
    totalCost: "$1.69",
    buildCount: 15,
  },
  zai_glm_5_2: {
    sourceRelease: "3.8.0",
    averageInferenceTime: "6m 21s (381.1s)",
    totalCost: "$4.46",
    buildCount: 15,
  },
  anthropic_claude_sonnet_5: {
    sourceRelease: "3.8.0",
    averageInferenceTime: "31m 3s (1863.1s)",
    totalCost: "$94.17",
    buildCount: 15,
  },
  openai_gpt_4_5_web_harness: {
    sourceRelease: "3.8.0",
    note: "Imported from the web harness; not directly comparable to API-generated runs.",
  },
  anthropic_claude_fable_5: {
    sourceRelease: "3.7.0",
    averageInferenceTime: "18m 04.4s (1,084.4s)",
    totalCost: "$54.93",
    buildCount: 15,
  },
  anthropic_claude_4_8_opus: {
    sourceRelease: "3.6.0",
    averageInferenceTime: "24m 47.9s (1,487.9s)",
    totalCost: "$41.52",
    buildCount: 15,
  },
  gemini_3_6_flash: {
    sourceRelease: "3.10.0",
    averageInferenceTime: "1m 41.9s (101.9s)",
    totalCost: "$2.84",
    buildCount: 15,
  },
  gemini_3_5_flash_lite: {
    sourceRelease: "3.10.0",
    averageInferenceTime: "25.7s",
    totalCost: "$0.38",
    buildCount: 15,
  },
  gemini_3_5_flash: {
    sourceRelease: "3.6.0",
    averageInferenceTime: "1m 54s (114.1s)",
    totalCost: "$12.90",
    buildCount: 15,
  },
  xai_grok_4_3: {
    sourceRelease: "3.4.0",
    averageInferenceTime: "3m 43s (223.1s)",
    totalCost: "$0.87",
  },
  xai_grok_4_20: {
    sourceRelease: "v3.0.0",
    averageInferenceTime: "~2m 29s",
    totalCost: "$18.44",
    buildCount: 15,
  },
  openai_gpt_5_5: {
    sourceRelease: "3.3.2",
    averageInferenceTime: "10m 24s (624s)",
    totalCost: "$19.98",
  },
  openai_gpt_5_5_pro: {
    sourceRelease: "3.3.2",
    averageInferenceTime: "21m 23.3s (1,283.3s)",
    totalCost: "$223.90",
  },
  openai_gpt_5_4: {
    totalCost: "~$25",
  },
  openai_gpt_5_4_pro: {
    averageInferenceTime: "56 minutes",
    totalCost: "$435",
  },
  openai_gpt_5_3_codex: {
    totalCost: "Under approximately $5",
  },
  deepseek_v4_pro: {
    sourceRelease: "3.3.2",
    totalCost: "$3.92",
  },
  anthropic_claude_4_7_opus: {
    sourceRelease: "v3.0.0",
    averageInferenceTime: "~43m 20s (~2,600s)",
    totalCost: "~$275",
  },
  anthropic_claude_4_6_opus: {
    totalCost: "~$22",
  },
  zai_glm_5_1: {
    sourceRelease: "v3.0.0",
    averageInferenceTime: "~17m 26s",
    totalCost: "$4.18",
    buildCount: 15,
  },
  moonshot_kimi_k2_6: {
    sourceRelease: "v3.0.0",
    totalCost: "$2.35",
  },
  moonshot_kimi_k3: {
    sourceRelease: "3.10.0",
    averageInferenceTime: "32m 46s (1966.0s)",
    totalCost: "$12.70",
    buildCount: 15,
  },
};

export const MODEL_BENCHMARK_PROFILES = Object.fromEntries(
  (Object.entries(MODEL_RUN_PARAMETERS) as [ModelKey, ModelRunParameters][]).map(
    ([modelKey, parameters]) => [
      modelKey,
      {
        parameters,
        ...MODEL_BENCHMARK_METADATA[modelKey],
      },
    ],
  ),
) as Record<ModelKey, ModelBenchmarkProfile>;

export function getModelBenchmarkProfile(modelKey: string): ModelBenchmarkProfile | null {
  return MODEL_BENCHMARK_PROFILES[modelKey as ModelKey] ?? null;
}
