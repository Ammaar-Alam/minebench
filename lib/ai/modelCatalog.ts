export type Provider = "openai" | "anthropic" | "gemini" | "moonshot" | "deepseek";

export type ModelKey =
  | "openai_gpt_5_2"
  | "openai_gpt_5_2_pro"
  | "openai_gpt_5_2_codex"
  | "openai_gpt_5_mini"
  | "openai_gpt_4_1"
  | "openai_gpt_4o"
  | "anthropic_claude_4_5_sonnet"
  | "anthropic_claude_4_5_opus"
  | "gemini_3_0_pro"
  | "gemini_3_0_flash"
  | "gemini_2_5_pro"
  | "moonshot_kimi_k2"
  | "deepseek_v3_2";

export type ModelCatalogEntry = {
  key: ModelKey;
  provider: Provider;
  modelId: string;
  displayName: string;
  enabled: boolean;
};

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    key: "openai_gpt_5_2",
    provider: "openai",
    modelId: "gpt-5.2",
    displayName: "GPT 5.2",
    enabled: true,
  },
  {
    key: "openai_gpt_5_2_pro",
    provider: "openai",
    modelId: "gpt-5.2-pro",
    displayName: "GPT 5.2 Pro",
    enabled: true,
  },
  {
    key: "openai_gpt_5_2_codex",
    provider: "openai",
    modelId: "gpt-5.2-codex",
    displayName: "GPT 5.2 Codex",
    enabled: false,
  },
  {
    key: "openai_gpt_5_mini",
    provider: "openai",
    modelId: "gpt-5-mini",
    displayName: "GPT 5 Mini",
    enabled: true,
  },
  {
    key: "openai_gpt_4_1",
    provider: "openai",
    modelId: "gpt-4.1",
    displayName: "GPT 4.1",
    enabled: true,
  },
  {
    key: "openai_gpt_4o",
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT 4o",
    enabled: true,
  },
  {
    key: "anthropic_claude_4_5_sonnet",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    displayName: "Claude 4.5 Sonnet",
    enabled: true,
  },
  {
    key: "anthropic_claude_4_5_opus",
    provider: "anthropic",
    modelId: "claude-opus-4-5",
    displayName: "Claude 4.5 Opus",
    enabled: true,
  },
  {
    key: "gemini_3_0_pro",
    provider: "gemini",
    modelId: "gemini-3-pro-preview",
    displayName: "Gemini 3.0 Pro",
    enabled: true,
  },
  {
    key: "gemini_3_0_flash",
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
    displayName: "Gemini 3.0 Flash",
    enabled: true,
  },
  {
    key: "gemini_2_5_pro",
    provider: "gemini",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    enabled: true,
  },
  {
    key: "moonshot_kimi_k2",
    provider: "moonshot",
    modelId: "kimi-k2-0905-preview",
    displayName: "Kimi K2",
    enabled: true,
  },
  {
    key: "deepseek_v3_2",
    provider: "deepseek",
    modelId: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    enabled: true,
  },
];

export function getModelByKey(key: ModelKey): ModelCatalogEntry {
  const found = MODEL_CATALOG.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown model key: ${key}`);
  return found;
}
