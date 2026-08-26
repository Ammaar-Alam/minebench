import { getAuthenticatedUserId } from "@/lib/auth/account";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { cancelSavedGeneration } from "@/lib/generations/service";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await getAuthenticatedUserId(request.headers.get("cookie"));
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to stop this generation." } }, 401);
  try {
    return apiJson(await cancelSavedGeneration(ownerId, (await context.params).id));
  } catch (error) {
    return apiServiceError(error);
  }
}
