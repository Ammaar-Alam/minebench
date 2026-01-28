export type Provider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "moonshot"
  | "deepseek"
  | "xai"
  | "zai"
  | "meta";

export type ModelKey =
  | "openai_gpt_5_2"
  | "openai_gpt_5_2_pro"
  | "openai_gpt_5_2_codex"
  | "openai_gpt_5_mini"
  | "openai_gpt_5_nano"
  | "openai_gpt_4_1"
  | "openai_gpt_4o"
  | "anthropic_claude_4_5_sonnet"
  | "anthropic_claude_4_5_opus"
  | "gemini_3_0_pro"
  | "gemini_3_0_flash"
  | "gemini_2_5_pro"
  | "moonshot_kimi_k2"
  | "moonshot_kimi_k2_5"
  | "deepseek_v3_2"
  | "xai_grok_4_1"
  | "zai_glm_4_7"
  | "meta_llama_4_maverick";

export type ModelCatalogEntry = {
  key: ModelKey;
  provider: Provider;
  modelId: string;
  displayName: string;
  enabled: boolean;
  // optional: OpenRouter model ID for fallback when direct provider key is missing/invalid
  openRouterModelId?: string;
  // optional: force routing via OpenRouter even if a direct provider key exists
  forceOpenRouter?: boolean;
};

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    key: "openai_gpt_5_2",
    provider: "openai",
    modelId: "gpt-5.2",
    displayName: "GPT 5.2",
    enabled: true,
    openRouterModelId: "openai/gpt-5.2",
  },
  {
    key: "openai_gpt_5_2_pro",
    provider: "openai",
    modelId: "gpt-5.2-pro",
    displayName: "GPT 5.2 Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.2-pro",
  },
  {
    key: "openai_gpt_5_2_codex",
    provider: "openai",
    modelId: "gpt-5.2-codex",
    displayName: "GPT 5.2 Codex",
    enabled: false,
    openRouterModelId: "openai/gpt-5.2-codex",
  },
  {
    key: "openai_gpt_5_mini",
    provider: "openai",
    modelId: "gpt-5-mini",
    displayName: "GPT 5 Mini",
    enabled: true,
    openRouterModelId: "openai/gpt-5-mini",
  },
  {
    key: "openai_gpt_5_nano",
    provider: "openai",
    modelId: "gpt-5-nano",
    displayName: "GPT 5 Nano",
    enabled: true,
    openRouterModelId: "openai/gpt-5-nano",
  },
  {
    key: "openai_gpt_4_1",
    provider: "openai",
    modelId: "gpt-4.1",
    displayName: "GPT 4.1",
    enabled: true,
    openRouterModelId: "openai/gpt-4.1",
  },
  {
    key: "openai_gpt_4o",
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT 4o",
    enabled: true,
    openRouterModelId: "openai/gpt-4o",
  },
  {
    key: "anthropic_claude_4_5_sonnet",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude 4.5 Sonnet",
    enabled: true,
    openRouterModelId: "anthropic/claude-sonnet-4.5",
  },
  {
    key: "anthropic_claude_4_5_opus",
    provider: "anthropic",
    modelId: "claude-opus-4-5",
    displayName: "Claude 4.5 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.5",
  },
  {
    key: "gemini_3_0_pro",
    provider: "gemini",
    modelId: "gemini-3-pro-preview",
    displayName: "Gemini 3.0 Pro",
    enabled: true,
    openRouterModelId: "google/gemini-3-pro-preview",
  },
  {
    key: "gemini_3_0_flash",
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
    displayName: "Gemini 3.0 Flash",
    enabled: true,
    openRouterModelId: "google/gemini-3-flash-preview",
  },
  {
    key: "gemini_2_5_pro",
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    enabled: true,
    openRouterModelId: "google/gemini-2.5-pro",
  },
  {
    key: "moonshot_kimi_k2",
    provider: "moonshot",
    modelId: "kimi-k2-0905-preview",
    displayName: "Kimi K2",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k2-thinking",
  },
  {
    key: "moonshot_kimi_k2_5",
    provider: "moonshot",
    modelId: "moonshotai/kimi-k2.5",
    displayName: "Kimi K2.5",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k2.5",
    forceOpenRouter: true,
  },
  {
    key: "deepseek_v3_2",
    provider: "deepseek",
    modelId: "deepseek-reasoner",
    displayName: "DeepSeek V3.2",
    enabled: true,
    openRouterModelId: "deepseek/deepseek-v3.2",
  },
  {
    key: "xai_grok_4_1",
    provider: "xai",
    modelId: "grok-4.1-fast",
    displayName: "Grok 4.1",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.1-fast",
  },
  {
    key: "zai_glm_4_7",
    provider: "zai",
    modelId: "glm-4.7",
    displayName: "Z.AI GLM 4.7",
    enabled: true,
    openRouterModelId: "z-ai/glm-4.7",
    forceOpenRouter: true,
  },
  {
    key: "meta_llama_4_maverick",
    provider: "meta",
    modelId: "llama-4-maverick",
    displayName: "Llama 4 Maverick",
    enabled: true,
    openRouterModelId: "meta-llama/llama-4-maverick",
    forceOpenRouter: true,
  },
];

export function getModelByKey(key: ModelKey): ModelCatalogEntry {
  const found = MODEL_CATALOG.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown model key: ${key}`);
  return found;
}
