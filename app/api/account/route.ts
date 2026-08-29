import { z } from "zod";
import { getPublicAccount } from "@/lib/auth/account";
import {
  getAuthenticatedAuthUser,
  getAuthenticatedUserId,
} from "@/lib/auth/request";
import { appendArenaSessionCookie } from "@/lib/arena/session";
import {
  deleteMineBenchAccount,
  serializeAccount,
} from "@/lib/account/service";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { updateGalleryNickname } from "@/lib/gallery/service";

export const runtime = "nodejs";

const nicknameRequest = z.object({
  publicNickname: z.string().max(80),
}).strict();
const deletionRequest = z.object({ confirm: z.literal(true) }).strict();

function authenticationRequired(message: string) {
  return apiJson({ error: { code: "authentication_required", message } }, 401);
}

export async function GET(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  const account = userId ? await getPublicAccount(userId) : null;
  return account
    ? apiJson({ account: serializeAccount(account) })
    : authenticationRequired("Sign in to view this account.");
}

export async function PATCH(request: Request) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return authenticationRequired("Sign in to update this account.");
  const parsed = nicknameRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson({ error: { code: "invalid_request", message: "Check the public name." } }, 400);
  }
  try {
    await updateGalleryNickname(userId, parsed.data.publicNickname);
    const account = await getPublicAccount(userId);
    return account
      ? apiJson({ account: serializeAccount(account) })
      : authenticationRequired("Account unavailable.");
  } catch (error) {
    return apiServiceError(error);
  }
}

export async function DELETE(request: Request) {
  const parsed = deletionRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiJson({ error: { code: "invalid_request", message: "Confirm account deletion." } }, 400);
  }
  const authUser = await getAuthenticatedAuthUser(request);
  const account = authUser ? await getPublicAccount(authUser.id) : null;
  if (!account) return authenticationRequired("Sign in again to delete this account.");
  try {
    const response = apiJson(await deleteMineBenchAccount(account.id));
    appendArenaSessionCookie(response, crypto.randomUUID());
    return response;
  } catch (error) {
    return apiServiceError(error);
  }
}
