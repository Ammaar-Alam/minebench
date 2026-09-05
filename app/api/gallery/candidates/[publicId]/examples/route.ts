import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { addGalleryExample, removeGalleryExample } from "@/lib/gallery/service";

export const runtime = "nodejs";

const requestSchema = z.object({
  generationId: z.string().trim().min(1).max(100),
  postAnonymously: z.boolean().default(false),
});

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to add an example." } }, 401);
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the saved generation." } }, 400);
  try {
    const result = await addGalleryExample(userId, (await context.params).publicId, parsed.data);
    return apiJson(result, result.created ? 201 : 200);
  } catch (error) {
    return apiServiceError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to remove a build." } }, 401);
  const parsed = z.object({ exampleId: z.string().min(1).max(191) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the Gallery build." } }, 400);
  try {
    return apiJson(await removeGalleryExample(userId, (await context.params).publicId, parsed.data.exampleId));
  } catch (error) {
    return apiServiceError(error);
  }
}
