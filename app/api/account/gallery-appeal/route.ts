import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { submitGalleryAppeal } from "@/lib/gallery/service";

export const runtime = "nodejs";

const appealRequest = z.object({
  explanation: z.string().trim().min(1).max(2000),
}).strict();

export async function POST(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return apiJson({
      error: { code: "authentication_required", message: "Sign in to appeal." },
    }, 401);
  }
  const parsed = appealRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson({ error: { code: "invalid_request", message: "Check the appeal." } }, 400);
  }
  try {
    return apiJson(await submitGalleryAppeal(userId, parsed.data.explanation));
  } catch (error) {
    return apiServiceError(error);
  }
}
