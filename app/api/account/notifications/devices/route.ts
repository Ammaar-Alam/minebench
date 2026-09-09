import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { pushDeviceSchema, registerPushDevice, removePushDevice } from "@/lib/notifications/service";

export const runtime = "nodejs";

async function updateDevice(request: Request, remove: boolean) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to update notifications." } }, 401);
  const parsed = pushDeviceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the notification device." } }, 400);
  try {
    return apiJson(await (remove ? removePushDevice : registerPushDevice)(userId, parsed.data));
  } catch (error) {
    return apiServiceError(error);
  }
}

export const PUT = (request: Request) => updateDevice(request, false);
export const DELETE = (request: Request) => updateDevice(request, true);
