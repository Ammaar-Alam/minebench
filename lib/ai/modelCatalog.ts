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

export type ModelKey =
  | "openai_gpt_5_5"
  | "openai_gpt_5_5_pro"
  | "openai_gpt_5_4"
  | "openai_gpt_5_4_pro"
  | "openai_gpt_5_4_mini"
  | "openai_gpt_5_4_nano"
  | "openai_gpt_5_3_codex"
  | "openai_gpt_5_2"
  | "openai_gpt_5_2_pro"
  | "openai_gpt_5_2_codex"
  | "openai_gpt_5_mini"
  | "openai_gpt_5_nano"
  | "openai_gpt_4_1"
  | "openai_gpt_4o"
  | "openai_gpt_oss_120b"
  | "anthropic_claude_4_5_sonnet"
  | "anthropic_claude_4_6_sonnet"
  | "anthropic_claude_4_5_opus"
  | "anthropic_claude_4_6_opus"
  | "anthropic_claude_4_7_opus"
  | "gemini_3_0_pro"
  | "gemini_3_1_pro"
  | "gemini_3_0_flash"
  | "gemini_3_1_flash_lite"
  | "gemini_2_5_pro"
  | "gemma_4_31b"
  | "moonshot_kimi_k2"
  | "moonshot_kimi_k2_6"
  | "moonshot_kimi_k2_5"
  | "deepseek_v4_pro"
  | "deepseek_v3_2"
  | "xai_grok_4_3"
  | "xai_grok_4_1"
  | "xai_grok_4_20"
  | "zai_glm_5_1"
  | "zai_glm_5"
  | "zai_glm_4_7"
  | "qwen_qwen3_max_thinking"
  | "qwen_qwen3_5_397b_a17b"
  | "minimax_m2_7"
  | "minimax_m2_5"
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
    key: "openai_gpt_5_5",
    provider: "openai",
    modelId: "gpt-5.5-2026-04-23",
    displayName: "GPT 5.5",
    enabled: true,
    openRouterModelId: "openai/gpt-5.5",
  },
  {
    key: "openai_gpt_5_5_pro",
    provider: "openai",
    modelId: "gpt-5.5-pro-2026-04-23",
    displayName: "GPT 5.5 Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.5-pro",
  },
  {
    key: "openai_gpt_5_4",
    provider: "openai",
    modelId: "gpt-5.4-2026-03-05",
    displayName: "GPT 5.4",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4",
  },
  {
    key: "openai_gpt_5_4_pro",
    provider: "openai",
    modelId: "gpt-5.4-pro-2026-03-05",
    displayName: "GPT 5.4 Pro",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4-pro",
  },
  {
    key: "openai_gpt_5_4_mini",
    provider: "openai",
    modelId: "gpt-5.4-mini",
    displayName: "GPT 5.4 Mini",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4-mini",
  },
  {
    key: "openai_gpt_5_4_nano",
    provider: "openai",
    modelId: "gpt-5.4-nano",
    displayName: "GPT 5.4 Nano",
    enabled: true,
    openRouterModelId: "openai/gpt-5.4-nano",
  },
  {
    key: "openai_gpt_5_3_codex",
    provider: "openai",
    modelId: "gpt-5.3-codex",
    displayName: "GPT 5.3 Codex",
    enabled: true,
    openRouterModelId: "openai/gpt-5.3-codex",
  },
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
    enabled: true,
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
    key: "openai_gpt_oss_120b",
    provider: "openai",
    modelId: "gpt-oss-120b",
    displayName: "GPT OSS 120B",
    enabled: true,
    openRouterModelId: "openai/gpt-oss-120b",
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
    key: "anthropic_claude_4_6_sonnet",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude 4.6 Sonnet",
    enabled: true,
    openRouterModelId: "anthropic/claude-sonnet-4.6",
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
    key: "anthropic_claude_4_6_opus",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    displayName: "Claude 4.6 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.6",
  },
  {
    key: "anthropic_claude_4_7_opus",
    provider: "anthropic",
    modelId: "claude-opus-4-7",
    displayName: "Claude 4.7 Opus",
    enabled: true,
    openRouterModelId: "anthropic/claude-opus-4.7",
  },
  {
    key: "gemini_3_0_pro",
    provider: "gemini",
    modelId: "gemini-3-pro-preview",
    displayName: "Gemini 3.0 Pro",
    enabled: false,
    openRouterModelId: "google/gemini-3-pro-preview",
  },
  {
    key: "gemini_3_1_pro",
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    enabled: true,
    openRouterModelId: "google/gemini-3.1-pro-preview",
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
    key: "gemini_3_1_flash_lite",
    provider: "gemini",
    modelId: "gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash-Lite",
    enabled: true,
    openRouterModelId: "google/gemini-3.1-flash-lite-preview",
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
    key: "gemma_4_31b",
    provider: "gemini",
    modelId: "gemma-4-31b-it",
    displayName: "Gemma 4 31B",
    enabled: true,
    openRouterModelId: "google/gemma-4-31b-it",
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
    key: "moonshot_kimi_k2_6",
    provider: "moonshot",
    modelId: "kimi-k2.6",
    displayName: "Kimi K2.6",
    enabled: true,
    openRouterModelId: "moonshotai/kimi-k2.6",
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
    key: "deepseek_v4_pro",
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    enabled: true,
  },
  {
    key: "deepseek_v3_2",
    provider: "deepseek",
    modelId: "deepseek/deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    enabled: true,
    openRouterModelId: "deepseek/deepseek-v3.2",
    forceOpenRouter: true,
  },
  {
    key: "xai_grok_4_3",
    provider: "xai",
    modelId: "grok-4.3",
    displayName: "Grok 4.3",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.3",
  },
  {
    key: "xai_grok_4_1",
    provider: "xai",
    modelId: "grok-4-1-fast-reasoning",
    displayName: "Grok 4.1 Fast",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.1-fast",
  },
  {
    key: "xai_grok_4_20",
    provider: "xai",
    modelId: "grok-4.20-0309-reasoning",
    displayName: "Grok 4.20",
    enabled: true,
    openRouterModelId: "x-ai/grok-4.20",
  },
  {
    key: "zai_glm_5_1",
    provider: "zai",
    modelId: "glm-5.1",
    displayName: "Z.AI GLM 5.1",
    enabled: true,
    openRouterModelId: "z-ai/glm-5.1",
    forceOpenRouter: true,
  },
  {
    key: "zai_glm_5",
    provider: "zai",
    modelId: "glm-5",
    displayName: "Z.AI GLM 5",
    enabled: true,
    openRouterModelId: "z-ai/glm-5",
    forceOpenRouter: true,
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
    key: "qwen_qwen3_max_thinking",
    provider: "qwen",
    modelId: "qwen3-max-thinking",
    displayName: "Qwen3 Max Thinking",
    enabled: true,
    openRouterModelId: "qwen/qwen3-max-thinking",
    forceOpenRouter: true,
  },
  {
    key: "qwen_qwen3_5_397b_a17b",
    provider: "qwen",
    modelId: "qwen3.5-397b-a17b",
    displayName: "Qwen 3.5 397B A17B",
    enabled: true,
    openRouterModelId: "qwen/qwen3.5-397b-a17b",
    forceOpenRouter: true,
  },
  {
    key: "minimax_m2_7",
    provider: "minimax",
    modelId: "MiniMax-M2.7",
    displayName: "MiniMax M2.7",
    enabled: true,
    openRouterModelId: "minimax/minimax-m2.7",
  },
  {
    key: "minimax_m2_5",
    provider: "minimax",
    modelId: "MiniMax-M2.5",
    displayName: "MiniMax M2.5",
    enabled: true,
    openRouterModelId: "minimax/minimax-m2.5",
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
