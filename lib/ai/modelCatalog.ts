export type Provider = "openai" | "anthropic" | "gemini";

export type ModelKey =
  | "openai_gpt_5_2"
  | "openai_gpt_5_2_pro"
  | "openai_gpt_5_mini"
  | "openai_gpt_4_1"
  | "anthropic_claude_4_5_sonnet"
  | "anthropic_claude_4_5_opus"
  | "gemini_3_0_pro"
  | "gemini_3_0_flash";

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
    key: "anthropic_claude_4_5_sonnet",
    provider: "anthropic",
    modelId: "claude-4.5-sonnet",
    displayName: "Claude 4.5 Sonnet",
    enabled: true,
  },
  {
    key: "anthropic_claude_4_5_opus",
    provider: "anthropic",
    modelId: "claude-4.5-opus",
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
];

export function getModelByKey(key: ModelKey): ModelCatalogEntry {
  const found = MODEL_CATALOG.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown model key: ${key}`);
  return found;
}
