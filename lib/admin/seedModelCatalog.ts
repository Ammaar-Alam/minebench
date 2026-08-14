import type { ModelCatalogEntry } from "@/lib/ai/modelCatalog";

export type SeedProviderKeyStatus = {
  openai: boolean;
  anthropic: boolean;
  gemini: boolean;
  moonshot: boolean;
  deepseek: boolean;
  minimax: boolean;
  xai: boolean;
  meta: boolean;
  openrouter: boolean;
};

const INITIAL_RATING_FIELDS = {
  eloRating: 1500,
  glickoRd: 350,
  glickoVolatility: 0.06,
  conservativeRating: 800,
};

export function modelCatalogSeedUpsertArgs(
  m: ModelCatalogEntry,
  enableCatalogModels: boolean,
) {
  const preserveEnabled = m.importOnly || (!enableCatalogModels && m.enabled);
  return {
    where: { key: m.key },
    create: {
      key: m.key,
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      // Local seeds mirror the catalog so the arena is immediately usable
      // Remote seeds stay staged until publication verification completes
      enabled: enableCatalogModels ? m.enabled : false,
      isBaseline: false,
      ...INITIAL_RATING_FIELDS,
    },
    update: {
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      ...(preserveEnabled ? {} : { enabled: m.enabled }),
    },
  };
}

export function getCatalogSeedGenerationModelKeys(
  models: readonly ModelCatalogEntry[],
): string[] {
  return models.filter((model) => model.enabled).map((model) => model.key);
}

export function isCatalogModelGeneratableForSeed(args: {
  model: ModelCatalogEntry;
  providerKeys: SeedProviderKeyStatus;
}): boolean {
  const { model, providerKeys } = args;
  if (model.importOnly) return false;

  const canUseOpenRouter = Boolean(providerKeys.openrouter && model.openRouterModelId);
  if (model.forceOpenRouter) return canUseOpenRouter;
  if (model.provider === "xai") return providerKeys.xai || canUseOpenRouter;

  if (model.provider === "openai") return providerKeys.openai || canUseOpenRouter;
  if (model.provider === "anthropic") return providerKeys.anthropic || canUseOpenRouter;
  if (model.provider === "gemini") return providerKeys.gemini || canUseOpenRouter;
  if (model.provider === "moonshot") return providerKeys.moonshot || canUseOpenRouter;
  if (model.provider === "deepseek") return providerKeys.deepseek || canUseOpenRouter;
  if (model.provider === "minimax") return providerKeys.minimax || canUseOpenRouter;
  if (model.provider === "meta") return providerKeys.meta || canUseOpenRouter;

  return true;
}
