import { claudeCapabilities } from "@/lib/ai/claudeModels";

// Per-model request facts that are provider policy: what a model accepts, not
// how MineBench prompts it
//
// Reasoning ladders live in reasoningProfiles, wire-format quirks in providers/

// Output ceiling in tokens, keyed by lowercased model ID
// Direct and OpenRouter IDs share a group since a ceiling belongs to the model
// Raises the request for models accepting more, clamps it for models accepting less
const OUTPUT_CEILINGS: readonly { tokens: number; ids: readonly string[] }[] = [
  { tokens: 1_048_576, ids: ["kimi-k3", "moonshotai/kimi-k3"] },
  { tokens: 1_000_000, ids: ["grok-4.3", "x-ai/grok-4.3"] },
  { tokens: 496_000, ids: ["grok-4.6", "x-ai/grok-4.6"] },
  { tokens: 500_000, ids: ["grok-4.5", "x-ai/grok-4.5"] },
  {
    tokens: 384_000,
    ids: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-0731",
    ],
  },
  { tokens: 131_072, ids: ["qwen3.8-max", "qwen/qwen3.8-max"] },
  { tokens: 272_000, ids: ["gpt-5-pro"] },
  // MiniMax M2.7 rejects the larger MineBench default on its OpenAI-compatible route
  {
    tokens: 131_072,
    ids: [
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "minimax-m2.7",
      "muse-spark-1.2",
      "meta/muse-spark-1.2",
    ],
  },
  {
    tokens: 65_536,
    ids: [
      "gemini-3.6-flash",
      "google/gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "google/gemini-3.5-flash-lite",
      "gemini-3.5-flash",
      "google/gemini-3.5-flash",
      "gemini-3-flash-preview",
      "google/gemini-3-flash-preview",
      "deepseek/deepseek-v3.2",
    ],
  },
  {
    tokens: 30_000,
    ids: ["grok-4-1-fast", "grok-4-1-fast-reasoning", "x-ai/grok-4.1-fast"],
  },
];

const OUTPUT_CEILING_BY_ID = new Map(
  OUTPUT_CEILINGS.flatMap(({ tokens, ids }) => ids.map((id) => [id, tokens] as const)),
);

// Families sharing a ceiling, checked after exact IDs so a member can override
// Direct GPT-5 only: the native budget covers reasoning plus output, while
// OpenRouter counts visible output alone and runs on the MineBench default
const OUTPUT_CEILING_PREFIXES: readonly { prefix: string; tokens: number }[] = [
  { prefix: "gpt-5", tokens: 128_000 },
];

// Models that should use provider-default sampling instead of MineBench's
// shared temperature, including models that reject sampling overrides
const DEFAULT_SAMPLING_IDS: readonly string[] = [
  "grok-4.6",
  "x-ai/grok-4.6",
  "kimi-k3",
  "moonshotai/kimi-k3",
  "qwen3.8-max",
  "qwen/qwen3.8-max",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash-lite",
];

const DEFAULT_SAMPLING_PREFIXES: readonly string[] = ["gpt-5.6", "openai/gpt-5.6"];

export function modelOutputCeiling(modelId: string): number | undefined {
  const normalized = modelId.toLowerCase();

  const claudeCeiling = claudeCapabilities(normalized).maxOutputTokens;
  if (claudeCeiling !== null) return claudeCeiling;

  const exact = OUTPUT_CEILING_BY_ID.get(normalized);
  if (exact !== undefined) return exact;

  return OUTPUT_CEILING_PREFIXES.find(({ prefix }) => normalized.startsWith(prefix))?.tokens;
}

export function modelUsesDefaultSampling(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    claudeCapabilities(normalized).defaultSamplingOnly ||
    DEFAULT_SAMPLING_IDS.includes(normalized) ||
    DEFAULT_SAMPLING_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}
