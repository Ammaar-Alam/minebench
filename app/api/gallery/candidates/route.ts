import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { readArenaSessionId } from "@/lib/arena/session";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { listGalleryCandidates, submitGalleryCandidate } from "@/lib/gallery/service";

export const runtime = "nodejs";

const submission = z.object({
  prompt: z.string().max(800).optional(),
  generationId: z.string().trim().min(1).max(100).optional(),
  postAnonymously: z.boolean().default(false),
}).refine((value) => Boolean(value.prompt) !== Boolean(value.generationId), {
  message: "Submit a prompt or saved generation.",
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  try {
    return apiJson(await listGalleryCandidates({
      sort: url.searchParams.get("sort") === "new" ? "new" : "top",
      cursor: url.searchParams.get("cursor"),
      limit: Number.isFinite(limit) ? limit : 24,
      sessionId: readArenaSessionId(request.headers.get("cookie")),
      userId: await getAuthenticatedUserId(request),
    }));
  } catch (error) {
    return apiServiceError(error);
  }
}

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to submit." } }, 401);
  const parsed = submission.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the submission." } }, 400);
  try {
    return apiJson(await submitGalleryCandidate(userId, parsed.data), 201);
  } catch (error) {
    return apiServiceError(error);
  }
}
