import { claudeCapabilities } from "@/lib/ai/claudeModels";
import { findCatalogEntryById } from "@/lib/ai/modelCatalog";

// Per-model request facts that are provider policy: what a model accepts, not
// how MineBench prompts it
//
// Reasoning ladders live in reasoningProfiles, wire-format quirks in providers/
//
// IDs are declared once per model: a lookup miss retries through the catalog's
// counterpart route ID, so listing either the native or OpenRouter form covers
// both. Alias IDs that are not catalogued (renamed releases, custom endpoints)
// still need their own entry.

// Output ceiling in tokens, keyed by lowercased model ID
// Raises the request for models accepting more, clamps it for models accepting less
const OUTPUT_CEILINGS: readonly { tokens: number; ids: readonly string[] }[] = [
  { tokens: 1_048_576, ids: ["kimi-k3"] },
  { tokens: 1_000_000, ids: ["grok-4.3"] },
  { tokens: 496_000, ids: ["grok-4.6"] },
  { tokens: 500_000, ids: ["grok-4.5"] },
  {
    tokens: 384_000,
    ids: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
    ],
  },
  { tokens: 131_072, ids: ["qwen3.8-max"] },
  { tokens: 272_000, ids: ["gpt-5-pro"] },
  // MiniMax M2.7 rejects the larger MineBench default on its OpenAI-compatible route
  {
    tokens: 131_072,
    ids: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "minimax-m2.7", "muse-spark-1.3", "muse-spark-1.2"],
  },
  {
    tokens: 65_536,
    ids: [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
      "deepseek/deepseek-v3.2",
    ],
  },
  {
    tokens: 30_000,
    ids: ["grok-4-1-fast", "grok-4-1-fast-reasoning"],
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
  "kimi-k3",
  "qwen3.8-max",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];

const DEFAULT_SAMPLING_PREFIXES: readonly string[] = ["gpt-5.6", "openai/gpt-5.6"];

const RECOMMENDED_TOP_P: readonly { topP: number; ids: readonly string[] }[] = [
  { topP: 0.95, ids: ["glm-5.3-flash"] },
];

// Returns the catalogued counterpart IDs for a model ID, so a fact declared
// under one route's ID also resolves from the other
function counterpartIds(normalized: string): string[] {
  const entry = findCatalogEntryById(normalized);
  if (!entry) return [];
  const ids = [entry.modelId.toLowerCase()];
  if (entry.openRouterModelId) ids.push(entry.openRouterModelId.toLowerCase());
  return ids.filter((id) => id !== normalized);
}

export function modelOutputCeiling(modelId: string): number | undefined {
  const normalized = modelId.toLowerCase();

  const claudeCeiling = claudeCapabilities(normalized).maxOutputTokens;
  if (claudeCeiling !== null) return claudeCeiling;

  for (const id of [normalized, ...counterpartIds(normalized)]) {
    const exact = OUTPUT_CEILING_BY_ID.get(id);
    if (exact !== undefined) return exact;
  }

  return OUTPUT_CEILING_PREFIXES.find(({ prefix }) => normalized.startsWith(prefix))?.tokens;
}

export function modelUsesDefaultSampling(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    claudeCapabilities(normalized).defaultSamplingOnly ||
    [normalized, ...counterpartIds(normalized)].some((id) =>
      DEFAULT_SAMPLING_IDS.includes(id),
    ) ||
    DEFAULT_SAMPLING_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function modelRecommendedTopP(modelId: string): number | undefined {
  const normalized = modelId.toLowerCase();
  for (const id of [normalized, ...counterpartIds(normalized)]) {
    const match = RECOMMENDED_TOP_P.find(({ ids }) => ids.includes(id));
    if (match) return match.topP;
  }
  return undefined;
}
