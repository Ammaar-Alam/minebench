import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { listAdminGenerations } from "@/lib/generations/service";

export const runtime = "nodejs";

const querySchema = z.object({
  ownerId: z.string().uuid().optional(),
  cursor: z.string().max(500).optional(),
  query: z.string().max(800).optional(),
  active: z.enum(["true", "false"]).optional(),
});

export async function GET(request: Request) {
  const adminId = await getAuthenticatedUserId(request);
  if (!adminId) return apiJson({ error: { code: "authentication_required", message: "Sign in to view generations." } }, 401);
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the generation filters." } }, 400);
  try {
    return apiJson(await listAdminGenerations(adminId, { ...parsed.data, active: parsed.data.active === "true" }));
  } catch (error) {
    return apiServiceError(error);
  }
}
