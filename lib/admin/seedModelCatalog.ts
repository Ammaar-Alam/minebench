import type { ModelCatalogEntry } from "@/lib/ai/modelCatalog";

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
      enabled: m.enabled,
      isBaseline: false,
      ...INITIAL_RATING_FIELDS,
    },
    update: {
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      ...(m.importOnly ? {} : { enabled: m.enabled }),
    },
  };
}
