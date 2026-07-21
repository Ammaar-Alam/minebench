import type { ModelKey } from "@/lib/ai/modelCatalog";

export type ModelRunParameter = {
  label: string;
  value: string;
};

export type ModelBenchmarkProfile = {
  sourceRelease?: string;
  parameters: readonly ModelRunParameter[];
  averageInferenceTime?: string;
  totalCost?: string;
  buildCount?: number;
  note?: string;
};

export const MODEL_BENCHMARK_PROFILES: Partial<Record<ModelKey, ModelBenchmarkProfile>> = {
  openai_gpt_5_6_sol: {
    sourceRelease: "3.9.0",
    parameters: [
      { label: "Reasoning mode", value: "Pro" },
      { label: "Reasoning effort", value: "Max" },
      { label: "Text verbosity", value: "High" },
      { label: "Combined reasoning/output cap", value: "128,000 tokens" },
    ],
    averageInferenceTime: "25m 16s (1516.2s)",
    totalCost: "$710.82",
    buildCount: 15,
  },
  xai_grok_4_5: {
    sourceRelease: "3.9.0",
    parameters: [
      { label: "Reasoning effort", value: "High" },
      { label: "Requested output budget", value: "500,000 tokens" },
      { label: "Accepted output budget", value: "262,144 tokens" },
    ],
    averageInferenceTime: "1m 48s (108.2s)",
    totalCost: "$1.69",
    buildCount: 15,
  },
  zai_glm_5_2: {
    sourceRelease: "3.8.0",
    parameters: [
      { label: "Reasoning effort", value: "XHigh → High" },
      { label: "Output cap", value: "131,072 tokens" },
    ],
    averageInferenceTime: "6m 21s (381.1s)",
    totalCost: "$4.46",
    buildCount: 15,
  },
  anthropic_claude_sonnet_5: {
    sourceRelease: "3.8.0",
    parameters: [
      { label: "Thinking", value: "Adaptive" },
      { label: "Reasoning effort", value: "XHigh" },
      { label: "Output cap", value: "128,000 tokens" },
    ],
    averageInferenceTime: "31m 3s (1863.1s)",
    totalCost: "$94.17",
    buildCount: 15,
  },
  openai_gpt_4_5_web_harness: {
    sourceRelease: "3.8.0",
    parameters: [{ label: "Source", value: "ChatGPT web harness" }],
    note: "Imported from the web harness; not directly comparable to API-generated runs.",
  },
  anthropic_claude_fable_5: {
    sourceRelease: "3.7.0",
    parameters: [
      { label: "Thinking", value: "Adaptive" },
      { label: "Reasoning effort", value: "Max" },
      { label: "Sampling", value: "Provider default" },
      { label: "Output cap", value: "128,000 tokens" },
    ],
    averageInferenceTime: "18m 4s (1084.4s)",
    totalCost: "$54.93",
    buildCount: 15,
  },
  anthropic_claude_4_8_opus: {
    sourceRelease: "3.6.0",
    parameters: [
      { label: "Thinking", value: "Adaptive" },
      { label: "Reasoning effort", value: "Max" },
      { label: "Output cap", value: "128,000 tokens" },
    ],
    averageInferenceTime: "24m 48s (1487.9s)",
    totalCost: "$41.52",
    buildCount: 15,
  },
  gemini_3_5_flash: {
    sourceRelease: "3.6.0",
    parameters: [
      { label: "Thinking level", value: "High" },
      { label: "Output cap", value: "65,536 tokens" },
    ],
    averageInferenceTime: "1m 54s (114.1s)",
    totalCost: "$12.90",
    buildCount: 15,
  },
  xai_grok_4_3: {
    sourceRelease: "3.4.0",
    parameters: [
      { label: "Reasoning", value: "Automatic" },
      { label: "Requested output budget", value: "1,000,000 tokens" },
      { label: "Fallback output budget", value: "983,040 tokens" },
    ],
    averageInferenceTime: "3m 43s (223.1s)",
    totalCost: "$0.87",
  },
  xai_grok_4_20: {
    sourceRelease: "v3.0.0",
    parameters: [{ label: "Reasoning", value: "Thinking enabled" }],
    averageInferenceTime: "~2m 29s",
    totalCost: "$18.44",
    buildCount: 15,
  },
  openai_gpt_5_5: {
    sourceRelease: "3.3.2",
    parameters: [
      { label: "Reasoning effort", value: "Max" },
      { label: "Text verbosity", value: "High" },
      { label: "Output cap", value: "128,000 tokens" },
    ],
    averageInferenceTime: "10m 24s (624.0s)",
    totalCost: "$19.984",
  },
  openai_gpt_5_5_pro: {
    sourceRelease: "3.3.2",
    parameters: [
      { label: "Reasoning effort", value: "Max" },
      { label: "Text verbosity", value: "High" },
      { label: "Output cap", value: "128,000 tokens" },
    ],
    averageInferenceTime: "21m 23s (1283.3s)",
    totalCost: "$223.889",
  },
  deepseek_v4_pro: {
    sourceRelease: "3.3.2",
    parameters: [],
    totalCost: "$3.92",
    note: "Run parameters and average inference time were not recorded for this model.",
  },
  anthropic_claude_4_7_opus: {
    sourceRelease: "v3.0.0",
    parameters: [{ label: "Reasoning effort", value: "Max" }],
    totalCost: "~$275",
    note: "Average inference time was not recorded for this model.",
  },
  zai_glm_5_1: {
    sourceRelease: "v3.0.0",
    parameters: [
      { label: "Reasoning", value: "Thinking enabled" },
      { label: "Output cap", value: "131,072 tokens" },
    ],
    averageInferenceTime: "~17m 26s",
    totalCost: "$4.18",
    buildCount: 15,
  },
  moonshot_kimi_k2_6: {
    sourceRelease: "v3.0.0",
    parameters: [{ label: "Reasoning", value: "Thinking enabled" }],
    averageInferenceTime: "~43m",
    totalCost: "$2.35",
    buildCount: 15,
  },
  moonshot_kimi_k3: {
    sourceRelease: "3.10.0 draft",
    parameters: [
      { label: "Reasoning effort", value: "Max" },
      { label: "Structured output", value: "Strict" },
      { label: "Completion ceiling", value: "1,048,576 tokens" },
    ],
    averageInferenceTime: "32m 46s (1966.0s)",
    totalCost: "$12.70",
    buildCount: 15,
  },
};

export function getModelBenchmarkProfile(modelKey: string): ModelBenchmarkProfile | null {
  return MODEL_BENCHMARK_PROFILES[modelKey as ModelKey] ?? null;
}
