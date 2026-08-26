import { getAuthenticatedUserId } from "@/lib/auth/account";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { retrySavedGeneration } from "@/lib/generations/service";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await getAuthenticatedUserId(request.headers.get("cookie"));
  if (!ownerId) {
    return apiJson({ error: { code: "authentication_required", message: "Sign in to retry this generation." } }, 401);
  }
  try {
    return apiJson({ generation: await retrySavedGeneration(ownerId, (await context.params).id) }, 202);
  } catch (error) {
    return apiServiceError(error);
  }
}
