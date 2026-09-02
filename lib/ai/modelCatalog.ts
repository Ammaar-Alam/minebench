export type Provider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "moonshot"
  | "deepseek"
  | "xai"
  | "zai"
  | "qwen"
  | "minimax"
  | "meta";

// ModelKey derives from CATALOG below; adding a model is one entry here
type ModelCatalogEntryShape = {
  key: string;
  provider: Provider;
  modelId: string;
  displayName: string;
  enabled: boolean;
  // short filename slug used for upload artifacts and --model selection
  slug: string;
  // optional: alternate OpenRouter route when the direct provider key is unavailable
  openRouterModelId?: string;
  // optional: force routing via OpenRouter even if a direct provider key exists
  forceOpenRouter?: boolean;
  // optional: model is available only through imported benchmark artifacts
  importOnly?: boolean;
};

const CATALOG = [
  {
    key: "openai_gpt_5_6_luna",
    slug: "gpt-5-6-luna",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    displayName: "GPT 5.6 Luna Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.6-luna-pro",
  },
  {
    key: "openai_gpt_5_6_sol",
    slug: "gpt-5-6-sol",
    provider: "openai",
    modelId: "gpt-5.6-sol",
    displayName: "GPT 5.6 Sol Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.6-sol-pro",
  },
  {
    key: "openai_gpt_5_5",
    slug: "gpt-5-5",
    provider: "openai",
    modelId: "gpt-5.5-2026-04-23",
    displayName: "GPT 5.5",
    enabled: true,
    openRouterModelId: "openai/gpt-5.5",
  },
  {
    key: "openai_gpt_5_5_pro",
    slug: "gpt-5-5-pro",
    provider: "openai",
    modelId: "gpt-5.5-pro-2026-04-23",
    displayName: "GPT 5.5 Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.5-pro",
  },
  {
    key: "openai_gpt_5_4",
    slug: "gpt-5-4",
    provider: "openai",
    modelId: "gpt-5.4-2026-03-05",
    displayName: "GPT 5.4",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4",
  },
  {
    key: "openai_gpt_5_4_pro",
    slug: "gpt-5-4-pro",
    provider: "openai",
    modelId: "gpt-5.4-pro-2026-03-05",
    displayName: "GPT 5.4 Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4-pro",
  },
  {
    key: "openai_gpt_5_4_mini",
    slug: "gpt-5-4-mini",
    provider: "openai",
    modelId: "gpt-5.4-mini",
    displayName: "GPT 5.4 Mini",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4-mini",
  },
  {
    key: "openai_gpt_5_4_nano",
    slug: "gpt-5-4-nano",
    provider: "openai",
    modelId: "gpt-5.4-nano",
    displayName: "GPT 5.4 Nano",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4-nano",
  },
  {
    key: "openai_gpt_5_3_codex",
    slug: "gpt-5-3-codex",
    provider: "openai",
    modelId: "gpt-5.3-codex",
    displayName: "GPT 5.3 Codex",
    enabled: true,
    openRouterModelId: "openai/gpt-5.3-codex",
  },
  {
    key: "openai_gpt_5_2",
    slug: "gpt-5-2",
    provider: "openai",
    modelId: "gpt-5.2",
    displayName: "GPT 5.2",
    enabled: true,
    openRouterModelId: "openai/gpt-5.2",
  },
  {
    key: "openai_gpt_5_2_pro",
    slug: "gpt-5-2-pro",
    provider: "openai",
    modelId: "gpt-5.2-pro",
    displayName: "GPT 5.2 Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.2-pro",
  },
  {
    key: "openai_gpt_5_2_codex",
    slug: "gpt-5-2-codex",
    provider: "openai",
    modelId: "gpt-5.2-codex",
    displayName: "GPT 5.2 Codex",
    enabled: true,
    openRouterModelId: "openai/gpt-5.2-codex",
  },
  {
    key: "openai_gpt_5_mini",
    slug: "gpt-5-mini",
    provider: "openai",
    modelId: "gpt-5-mini",
    displayName: "GPT 5 Mini",
    enabled: true,
    openRouterModelId: "openai/gpt-5-mini",
  },
  {
    key: "openai_gpt_5_nano",
    slug: "gpt-5-nano",
    provider: "openai",
    modelId: "gpt-5-nano",
    displayName: "GPT 5 Nano",
    enabled: true,
    openRouterModelId: "openai/gpt-5-nano",
  },
  {
    key: "openai_gpt_4_1",
    slug: "gpt-4-1",
    provider: "openai",
    modelId: "gpt-4.1",
    displayName: "GPT 4.1",
    enabled: true,
    openRouterModelId: "openai/gpt-4.1",
  },
  {
    key: "openai_gpt_4_5_web_harness",
    slug: "gpt-4-5-web-harness",
    provider: "openai",
    modelId: "gpt-4.5-preview",
    displayName: "GPT 4.5 (web harness)",
    enabled: false,
    importOnly: true,
  },
  {
    key: "openai_gpt_4o",
    slug: "gpt-4o",
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT 4o",
    enabled: true,
    openRouterModelId: "openai/gpt-4o",
  },
  {
    key: "openai_gpt_oss_120b",
    slug: "gpt-oss-120b",
    provider: "openai",
    modelId: "gpt-oss-120b",
    displayName: "GPT OSS 120B",
    enabled: true,
    openRouterModelId: "openai/gpt-oss-120b",
  },
  {
    key: "anthropic_claude_fable_5_1",
    slug: "claude-fable-5-1",
    provider: "anthropic",
    modelId: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    enabled: true,
    openRouterModelId: "anthropic/claude-fable-5.1",
  },
  {
    key: "anthropic_claude_fable_5",
    slug: "claude-fable-5",
    provider: "anthropic",
    modelId: "claude-fable-5",
    displayName: "Claude Fable 5",
    enabled: true,
    openRouterModelId: "anthropic/claude-fable-5",
  },
  {
    key: "anthropic_claude_opus_5",
    slug: "opus-5",
    provider: "anthropic",
    modelId: "claude-opus-5",
    displayName: "Claude Opus 5",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-5",
  },
  {
    key: "anthropic_claude_sonnet_5",
    slug: "sonnet-5",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    enabled: true,
    openRouterModelId: "anthropic/claude-sonnet-5",
  },
  {
    key: "anthropic_claude_4_5_sonnet",
    slug: "sonnet",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude 4.5 Sonnet",
    enabled: true,
    openRouterModelId: "anthropic/claude-sonnet-4.5",
  },
  {
    key: "anthropic_claude_4_6_sonnet",
    slug: "sonnet-4-6",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude 4.6 Sonnet",
    enabled: true,
    openRouterModelId: "anthropic/claude-sonnet-4.6",
  },
  {
    key: "anthropic_claude_4_5_opus",
    slug: "opus",
    provider: "anthropic",
    modelId: "claude-opus-4-5",
    displayName: "Claude 4.5 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.5",
  },
  {
    key: "anthropic_claude_4_6_opus",
    slug: "opus-4-6",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    displayName: "Claude 4.6 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.6",
  },
  {
    key: "anthropic_claude_4_7_opus",
    slug: "opus-4-7",
    provider: "anthropic",
    modelId: "claude-opus-4-7",
    displayName: "Claude 4.7 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.7",
  },
  {
    key: "anthropic_claude_4_8_opus",
    slug: "opus-4-8",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    displayName: "Claude 4.8 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.8",
  },
  {
    key: "gemini_3_7_flash",
    slug: "gemini-3-7-flash",
    provider: "gemini",
    modelId: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    enabled: true,
    openRouterModelId: "google/gemini-3.7-flash",
  },
  {
    key: "gemini_3_6_flash",
    slug: "gemini-3-6-flash",
    provider: "gemini",
    modelId: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    enabled: true,
    openRouterModelId: "google/gemini-3.6-flash",
  },
  {
    key: "gemini_3_5_flash_lite",
    slug: "gemini-3-5-flash-lite",
    provider: "gemini",
    modelId: "gemini-3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite",
    enabled: true,
    openRouterModelId: "google/gemini-3.5-flash-lite",
  },
  {
    key: "gemini_3_5_flash",
    slug: "gemini-3-5-flash",
    provider: "gemini",
    modelId: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    enabled: true,
    openRouterModelId: "google/gemini-3.5-flash",
  },
  {
    key: "gemini_3_0_pro",
    slug: "gemini-pro",
    provider: "gemini",
    modelId: "gemini-3-pro-preview",
    displayName: "Gemini 3.0 Pro",
    enabled: false,
    openRouterModelId: "google/gemini-3-pro-preview",
  },
  {
    key: "gemini_3_1_pro",
    slug: "gemini-3-1-pro",
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    enabled: true,
    openRouterModelId: "google/gemini-3.1-pro-preview",
  },
  {
    key: "gemini_3_0_flash",
    slug: "gemini-flash",
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
    displayName: "Gemini 3.0 Flash",
    enabled: true,
    openRouterModelId: "google/gemini-3-flash-preview",
  },
  {
    key: "gemini_3_1_flash_lite",
    slug: "gemini-3-1-flash-lite",
    provider: "gemini",
    modelId: "gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash-Lite",
    enabled: true,
    openRouterModelId: "google/gemini-3.1-flash-lite-preview",
  },
  {
    key: "gemini_2_5_pro",
    slug: "gemini-2-5-pro",
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    enabled: true,
    openRouterModelId: "google/gemini-2.5-pro",
  },
  {
    key: "gemma_4_31b",
    slug: "gemma-4-31b",
    provider: "gemini",
    modelId: "gemma-4-31b-it",
    displayName: "Gemma 4 31B",
    enabled: true,
    openRouterModelId: "google/gemma-4-31b-it",
  },
  {
    key: "moonshot_kimi_k3",
    slug: "kimi-k3",
    provider: "moonshot",
    modelId: "kimi-k3",
    displayName: "Kimi K3",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k3",
  },
  {
    key: "moonshot_kimi_k2",
    slug: "kimi-k2",
    provider: "moonshot",
    modelId: "kimi-k2-0905-preview",
    displayName: "Kimi K2",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k2-thinking",
  },
  {
    key: "moonshot_kimi_k2_6",
    slug: "kimi-k2-6",
    provider: "moonshot",
    modelId: "kimi-k2.6",
    displayName: "Kimi K2.6",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k2.6",
  },
  {
    key: "moonshot_kimi_k2_5",
    slug: "kimi-k2-5",
    provider: "moonshot",
    modelId: "moonshotai/kimi-k2.5",
    displayName: "Kimi K2.5",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k2.5",
    forceOpenRouter: true,
  },
  {
    key: "deepseek_v4_pro",
    slug: "deepseek-v4-pro",
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro Preview",
    enabled: true,
  },
  {
    key: "deepseek_v4_flash_0731",
    slug: "deepseek-v4-flash-0731",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash 0731",
    enabled: true,
    openRouterModelId: "deepseek/deepseek-v4-flash-0731",
  },
  {
    key: "deepseek_v3_2",
    slug: "deepseek-v3-2",
    provider: "deepseek",
    modelId: "deepseek/deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    enabled: true,
    openRouterModelId: "deepseek/deepseek-v3.2",
    forceOpenRouter: true,
  },
  {
    key: "xai_grok_4_6",
    slug: "grok-4-6",
    provider: "xai",
    modelId: "grok-4.6",
    displayName: "Grok 4.6",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.6",
  },
  {
    key: "xai_grok_4_5",
    slug: "grok-4-5",
    provider: "xai",
    modelId: "grok-4.5",
    displayName: "Grok 4.5",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.5",
  },
  {
    key: "xai_grok_4_3",
    slug: "grok-4-3",
    provider: "xai",
    modelId: "grok-4.3",
    displayName: "Grok 4.3",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.3",
  },
  {
    key: "xai_grok_4_1",
    slug: "grok-4-1",
    provider: "xai",
    modelId: "grok-4-1-fast-reasoning",
    displayName: "Grok 4.1 Fast",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.1-fast",
  },
  {
    key: "xai_grok_4_20",
    slug: "grok-4-20",
    provider: "xai",
    modelId: "grok-4.20-0309-reasoning",
    displayName: "Grok 4.20",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.20",
  },
  {
    key: "zai_glm_5_3",
    slug: "glm-5-3",
    provider: "zai",
    modelId: "glm-5.3",
    displayName: "Z.AI GLM 5.3",
    enabled: true,
    openRouterModelId: "z-ai/glm-5.3",
  },
  {
    key: "zai_glm_5_3_flash",
    slug: "glm-5-3-flash",
    provider: "zai",
    modelId: "glm-5.3-flash",
    displayName: "Z.AI GLM 5.3 Flash",
    enabled: true,
    openRouterModelId: "z-ai/glm-5.3-flash",
  },
  {
    key: "zai_glm_5_2",
    slug: "glm-5-2",
    provider: "zai",
    modelId: "glm-5.2",
    displayName: "Z.AI GLM 5.2",
    enabled: true,
    openRouterModelId: "z-ai/glm-5.2",
    forceOpenRouter: true,
  },
  {
    key: "zai_glm_5_1",
    slug: "glm-5-1",
    provider: "zai",
    modelId: "glm-5.1",
    displayName: "Z.AI GLM 5.1",
    enabled: true,
    openRouterModelId: "z-ai/glm-5.1",
    forceOpenRouter: true,
  },
  {
    key: "zai_glm_5",
    slug: "glm-5",
    provider: "zai",
    modelId: "glm-5",
    displayName: "Z.AI GLM 5",
    enabled: true,
    openRouterModelId: "z-ai/glm-5",
    forceOpenRouter: true,
  },
  {
    key: "zai_glm_4_7",
    slug: "glm-4-7",
    provider: "zai",
    modelId: "glm-4.7",
    displayName: "Z.AI GLM 4.7",
    enabled: true,
    openRouterModelId: "z-ai/glm-4.7",
    forceOpenRouter: true,
  },
  {
    key: "qwen_qwen3_max_thinking",
    slug: "qwen3-max-thinking",
    provider: "qwen",
    modelId: "qwen3-max-thinking",
    displayName: "Qwen3 Max Thinking",
    enabled: true,
    openRouterModelId: "qwen/qwen3-max-thinking",
    forceOpenRouter: true,
  },
  {
    key: "qwen_qwen3_5_397b_a17b",
    slug: "qwen3-5-397b-a17b",
    provider: "qwen",
    modelId: "qwen3.5-397b-a17b",
    displayName: "Qwen 3.5 397B A17B",
    enabled: true,
    openRouterModelId: "qwen/qwen3.5-397b-a17b",
    forceOpenRouter: true,
  },
  {
    key: "qwen_qwen3_8_max",
    slug: "qwen3-8-max",
    provider: "qwen",
    modelId: "qwen3.8-max",
    displayName: "Qwen 3.8 Max",
    enabled: true,
    openRouterModelId: "qwen/qwen3.8-max",
    forceOpenRouter: true,
  },
  {
    key: "minimax_m2_7",
    slug: "minimax-m2-7",
    provider: "minimax",
    modelId: "MiniMax-M2.7",
    displayName: "MiniMax M2.7",
    enabled: true,
    openRouterModelId: "minimax/minimax-m2.7",
  },
  {
    key: "minimax_m2_5",
    slug: "minimax-m2-5",
    provider: "minimax",
    modelId: "MiniMax-M2.5",
    displayName: "MiniMax M2.5",
    enabled: true,
    openRouterModelId: "minimax/minimax-m2.5",
  },
  {
    key: "meta_muse_spark_1_2",
    slug: "muse-spark-1-2",
    provider: "meta",
    modelId: "muse-spark-1.2",
    displayName: "Muse Spark 1.2",
    enabled: true,
    openRouterModelId: "meta/muse-spark-1.2",
  },
  {
    key: "meta_llama_4_maverick",
    slug: "llama-4-maverick",
    provider: "meta",
    modelId: "llama-4-maverick",
    displayName: "Llama 4 Maverick",
    enabled: true,
    openRouterModelId: "meta-llama/llama-4-maverick",
    forceOpenRouter: true,
  },
] as const satisfies readonly ModelCatalogEntryShape[];

export type ModelKey = (typeof CATALOG)[number]["key"];

export type ModelCatalogEntry = Omit<ModelCatalogEntryShape, "key"> & { key: ModelKey };

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = CATALOG;

const CATALOG_BY_ID = new Map<string, ModelCatalogEntry>();
for (const model of MODEL_CATALOG) {
  CATALOG_BY_ID.set(model.modelId.toLowerCase(), model);
  if (model.openRouterModelId) {
    CATALOG_BY_ID.set(model.openRouterModelId.toLowerCase(), model);
  }
}

// Exact identity lookup across both route namespaces; family-prefix fallbacks
// belong to the capability tables, not to identity
export function findCatalogEntryById(modelId: string): ModelCatalogEntry | undefined {
  return CATALOG_BY_ID.get(modelId.trim().toLowerCase());
}

// Accepts a canonical key or slug; used by admin tooling and scripts
export function findCatalogEntryBySlugOrKey(value: string): ModelCatalogEntry | undefined {
  const normalized = value.trim();
  return MODEL_CATALOG.find(
    (model) => model.key === normalized || model.slug === normalized,
  );
}

export function getModelByKey(key: ModelKey): ModelCatalogEntry {
  const found = MODEL_CATALOG.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown model key: ${key}`);
  return found;
}

export function resolveModelDisplayName(key: string, fallback: string): string {
  return MODEL_CATALOG.find((model) => model.key === key)?.displayName ?? fallback;
}

export function resolveModelSlug(keyOrSlug: string): string {
  const normalized = keyOrSlug.trim();
  const entry = MODEL_CATALOG.find(
    (model) => model.key === normalized || model.slug === normalized,
  );
  return entry?.slug ?? normalized;
}
