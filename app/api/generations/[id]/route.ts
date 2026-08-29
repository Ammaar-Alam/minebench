import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import {
  GenerationServiceError,
  getSavedGeneration,
  removeSavedGeneration,
} from "@/lib/generations/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await getAuthenticatedUserId(request);
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to view this generation." } }, 401);
  const generation = await getSavedGeneration(ownerId, (await context.params).id);
  return generation
    ? apiJson({ generation })
    : apiServiceError(new GenerationServiceError("not_found", "Saved generation not found."));
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await getAuthenticatedUserId(request);
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to remove this generation." } }, 401);
  const body = (await request.json().catch(() => null)) as { acknowledgePublicExamples?: unknown } | null;
  try {
    return apiJson(await removeSavedGeneration(ownerId, (await context.params).id, {
      acknowledgePublicExamples: body?.acknowledgePublicExamples === true,
    }));
  } catch (error) {
    return apiServiceError(error);
  }
}
