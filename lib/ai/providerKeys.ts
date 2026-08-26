import { getModelByKey } from "@/lib/ai/modelCatalog";
import type { GenerateModelRequest, ProviderApiKeys } from "@/lib/ai/types";

const API_KEYS_STORAGE_KEY = "mb_provider_keys_v1";
const PROVIDER_KEY_NAMES = [
  "openai",
  "anthropic",
  "gemini",
  "moonshot",
  "deepseek",
  "minimax",
  "xai",
  "meta",
  "zai",
  "openrouter",
  "custom",
] as const satisfies ReadonlyArray<keyof ProviderApiKeys>;

export function isProviderApiKeyName(value: string): value is keyof ProviderApiKeys {
  return PROVIDER_KEY_NAMES.some((name) => name === value);
}

export function loadProviderKeysFromStorage(): ProviderApiKeys {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(API_KEYS_STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    return Object.fromEntries(PROVIDER_KEY_NAMES.flatMap((name) => {
      const value = source[name];
      return typeof value === "string" && value.trim() ? [[name, value.trim()]] : [];
    })) as ProviderApiKeys;
  } catch {
    return {};
  }
}

export function saveProviderKeysToStorage(keys: ProviderApiKeys): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Local storage can be unavailable in restricted browser contexts
  }
}

export function selectGenerationProviderKeys(
  models: GenerateModelRequest[],
  providerKeys: ProviderApiKeys,
): ProviderApiKeys {
  const selected: ProviderApiKeys = {};
  const include = (provider: keyof ProviderApiKeys): boolean => {
    const value = providerKeys[provider]?.trim();
    if (!value) return false;
    selected[provider] = value;
    return true;
  };

  for (const request of models) {
    if (request.kind === "custom") {
      include(request.provider === "custom" ? "custom" : "openrouter");
      continue;
    }

    const model = getModelByKey(request.modelKey);
    const directProvider = model.provider as keyof ProviderApiKeys;
    if (!model.forceOpenRouter && include(directProvider)) continue;
    if (model.openRouterModelId) include("openrouter");
  }
  return selected;
}
