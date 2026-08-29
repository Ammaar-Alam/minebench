import { MODEL_CATALOG } from "@/lib/ai/modelCatalog";
import { isProviderApiKeyName } from "@/lib/ai/providerKeys";

export const runtime = "nodejs";

const HOSTED_GEMINI_MODEL_KEY = "gemini_3_7_flash";

export async function GET() {
  const hostedGeminiAvailable = Boolean(process.env.MINEBENCH_FREE_OPENROUTER_API_KEY?.trim());
  return Response.json({
    models: MODEL_CATALOG
      .filter((model) => model.enabled && !model.importOnly)
      .map((model) => ({
        key: model.key,
        provider: model.provider,
        displayName: model.displayName,
        directKey: !model.forceOpenRouter && isProviderApiKeyName(model.provider)
          ? model.provider
          : null,
        openRouter: Boolean(model.openRouterModelId),
        hostedEligible: hostedGeminiAvailable && model.key === HOSTED_GEMINI_MODEL_KEY,
      })),
  }, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
