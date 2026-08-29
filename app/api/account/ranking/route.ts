import { getPersonalRanking } from "@/lib/account/personalRanking";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import { apiJson, apiServiceError } from "@/lib/gallery/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return apiJson({
      error: { code: "authentication_required", message: "Sign in to view your ranking." },
    }, 401);
  }
  try {
    return apiJson(await getPersonalRanking(userId));
  } catch (error) {
    return apiServiceError(error);
  }
}
