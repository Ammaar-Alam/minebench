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

export function modelCatalogSeedUpsertArgs(m: ModelCatalogEntry) {
  return {
    where: { key: m.key },
    create: {
      key: m.key,
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      // Seeding never activates a model, so a freshly created row starts
      // staged even when the catalog marks it enabled; publish verification
      // is the only path that puts a model on public surfaces
      enabled: false,
      isBaseline: false,
      ...INITIAL_RATING_FIELDS,
    },
    update: {
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      // Seeding may retire a model the catalog disabled, but never activates
      // one: a staged (disabled) model goes live only through publish
      // verification, so a partial cohort cannot reach public surfaces
      ...(m.importOnly || m.enabled ? {} : { enabled: false }),
    },
  };
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
