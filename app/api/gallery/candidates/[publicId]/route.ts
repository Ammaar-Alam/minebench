import { getAuthenticatedUserId } from "@/lib/auth/request";
import { readArenaSessionId } from "@/lib/arena/session";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { GalleryServiceError, getGalleryCandidate, normalizeGallerySort, removeGalleryCandidate } from "@/lib/gallery/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const url = new URL(request.url);
  const candidate = await getGalleryCandidate((await context.params).publicId, {
    sessionId: readArenaSessionId(request.headers.get("cookie")),
    userId: await getAuthenticatedUserId(request),
    examplesCursor: url.searchParams.get("examplesCursor"),
    navigationSort: normalizeGallerySort(url.searchParams.get("sort")),
  });
  return candidate
    ? apiJson({ candidate })
    : apiServiceError(new GalleryServiceError("not_found", "Gallery prompt not found."));
}

export async function DELETE(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to remove this prompt." } }, 401);
  try {
    return apiJson(await removeGalleryCandidate(userId, (await context.params).publicId));
  } catch (error) {
    return apiServiceError(error);
  }
}
