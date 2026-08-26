import { getModelByKey } from "@/lib/ai/modelCatalog";
import { assertSafeCustomApiUrl } from "@/lib/ai/providers/customApiGuard";
import type { GenerateModelRequest, ProviderApiKeys } from "@/lib/ai/types";

export type ResolvedSavedGenerationModel = {
  modelKind: "catalog" | "openrouter" | "custom";
  modelKey?: string;
  modelProvider: string;
  modelId: string;
  modelDisplayName: string;
  openRouterModelId?: string;
  customBaseUrl?: string;
  preferOpenRouter: boolean;
  credential: {
    provider: keyof ProviderApiKeys;
    value: string;
  };
};

function keyForProvider(provider: string, keys: ProviderApiKeys): string | undefined {
  return keys[provider as keyof ProviderApiKeys]?.trim() || undefined;
}

export async function resolveSavedGenerationModel(
  request: GenerateModelRequest,
  providerKeys: ProviderApiKeys,
  deps: { assertSafeCustomApiUrl: (value: string) => Promise<void> } = {
    assertSafeCustomApiUrl,
  },
): Promise<ResolvedSavedGenerationModel> {
  if (request.kind === "custom" && request.provider === "custom") {
    await deps.assertSafeCustomApiUrl(request.baseUrl);
    const value = providerKeys.custom?.trim();
    if (!value) throw new Error("missing_provider_key");
    return {
      modelKind: "custom",
      modelProvider: "custom",
      modelId: request.modelId,
      modelDisplayName: request.displayName,
      customBaseUrl: request.baseUrl,
      preferOpenRouter: false,
      credential: { provider: "custom", value },
    };
  }

  if (request.kind === "custom") {
    const value = providerKeys.openrouter?.trim();
    if (!value) throw new Error("missing_provider_key");
    return {
      modelKind: "openrouter",
      modelProvider: "custom",
      modelId: request.modelId,
      modelDisplayName: request.displayName,
      openRouterModelId: request.modelId,
      preferOpenRouter: false,
      credential: { provider: "openrouter", value },
    };
  }

  const model = getModelByKey(request.modelKey);
  const directKey = keyForProvider(model.provider, providerKeys);
  const openRouterKey = providerKeys.openrouter?.trim();
  if (!model.forceOpenRouter && directKey) {
    return {
      modelKind: "catalog",
      modelKey: model.key,
      modelProvider: model.provider,
      modelId: model.modelId,
      modelDisplayName: model.displayName,
      openRouterModelId: model.openRouterModelId,
      preferOpenRouter: false,
      credential: {
        provider: model.provider as keyof ProviderApiKeys,
        value: directKey,
      },
    };
  }
  if (model.openRouterModelId && openRouterKey) {
    return {
      modelKind: "catalog",
      modelKey: model.key,
      modelProvider: model.provider,
      modelId: model.modelId,
      modelDisplayName: model.displayName,
      openRouterModelId: model.openRouterModelId,
      preferOpenRouter: true,
      credential: { provider: "openrouter", value: openRouterKey },
    };
  }
  throw new Error("missing_provider_key");
}
