import { getModelByKey } from "@/lib/ai/modelCatalog";
import type { GenerateModelRequest, ProviderApiKeys } from "@/lib/ai/types";

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
