import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { retrySavedGeneration } from "@/lib/generations/service";

export const runtime = "nodejs";

const retryRequest = z.object({
  providerKey: z.string().trim().min(1).max(4000).optional(),
  customBaseUrl: z.string().trim().url().max(4000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await getAuthenticatedUserId(request);
  if (!ownerId) {
    return apiJson({ error: { code: "authentication_required", message: "Sign in to retry this generation." } }, 401);
  }
  const parsed = retryRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson({ error: { code: "missing_provider_key", message: "Reconnect this model in Generate." } }, 400);
  }
  try {
    return apiJson({ generation: await retrySavedGeneration(ownerId, (await context.params).id, parsed.data) }, 202);
  } catch (error) {
    return apiServiceError(error);
  }
}
