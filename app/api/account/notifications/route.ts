import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { getNotificationSettings, notificationSettingsSchema, updateNotificationSettings } from "@/lib/notifications/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to view notifications." } }, 401);
  try {
    return apiJson(await getNotificationSettings(userId));
  } catch (error) {
    return apiServiceError(error);
  }
}

export async function PUT(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return apiJson({ error: { code: "authentication_required", message: "Sign in to update notifications." } }, 401);
  const parsed = notificationSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the notification settings." } }, 400);
  try {
    return apiJson(await updateNotificationSettings(userId, parsed.data));
  } catch (error) {
    return apiServiceError(error);
  }
}
