import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/account";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { addGalleryExample } from "@/lib/gallery/service";

export const runtime = "nodejs";

const requestSchema = z.object({
  generationId: z.string().trim().min(1).max(100),
  postAnonymously: z.boolean().default(false),
});

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const userId = await getAuthenticatedUserId(request.headers.get("cookie"));
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to add an example." } }, 401);
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the saved generation." } }, 400);
  try {
    return apiJson(await addGalleryExample(userId, (await context.params).publicId, parsed.data), 201);
  } catch (error) {
    return apiServiceError(error);
  }
}
