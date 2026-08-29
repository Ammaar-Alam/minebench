import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import {
  ARENA_SESSION_COOKIE,
  ARENA_SESSION_COOKIE_OPTIONS,
  readArenaSessionId,
} from "@/lib/arena/session";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { setGalleryVote } from "@/lib/gallery/service";
import { isVoteWriteBlocked, trustedClientIp } from "@/lib/voteBlock";

export const runtime = "nodejs";

const requestSchema = z.object({ upvoted: z.boolean() });

export async function PUT(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the vote." } }, 400);
  const existing = readArenaSessionId(request.headers.get("cookie"));
  const sessionId = existing ?? crypto.randomUUID();
  const userId = await getAuthenticatedUserId(request);
  try {
    const blocked = await isVoteWriteBlocked({
      userId,
      sessionId,
      ip: trustedClientIp(request.headers),
    });
    const result = await setGalleryVote({
      publicId: (await context.params).publicId,
      sessionId,
      userId,
      upvoted: parsed.data.upvoted,
      blocked,
    });
    const response = apiJson(result);
    if (!existing) {
      response.headers.append(
        "Set-Cookie",
        `${ARENA_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${ARENA_SESSION_COOKIE_OPTIONS.maxAge}; HttpOnly; SameSite=Lax${ARENA_SESSION_COOKIE_OPTIONS.secure ? "; Secure" : ""}`,
      );
    }
    return response;
  } catch (error) {
    return apiServiceError(error);
  }
}
