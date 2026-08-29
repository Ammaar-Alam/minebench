import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import {
  ARENA_SESSION_COOKIE,
  ARENA_SESSION_COOKIE_OPTIONS,
  readArenaSessionId,
} from "@/lib/arena/session";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { GalleryServiceError, submitGalleryReport } from "@/lib/gallery/service";
import { hashVoteIp, hashVoteSession, trustedClientIp } from "@/lib/voteBlock";

export const runtime = "nodejs";

const report = z.object({
  candidateId: z.string().trim().min(1).max(100).optional(),
  exampleId: z.string().trim().min(1).max(100).optional(),
  reason: z.enum(["OFFENSIVE", "SPAM", "MISLEADING", "OTHER"]),
  note: z.string().trim().max(1000).optional(),
}).refine((value) => Boolean(value.candidateId) !== Boolean(value.exampleId), {
  message: "Choose one contribution.",
});

function submittedResponse(existingSessionId: string | null, sessionId: string) {
  const response = apiJson({ submitted: true });
  if (!existingSessionId) {
    response.headers.append(
      "Set-Cookie",
      `${ARENA_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${ARENA_SESSION_COOKIE_OPTIONS.maxAge}; HttpOnly; SameSite=Lax${ARENA_SESSION_COOKIE_OPTIONS.secure ? "; Secure" : ""}`,
    );
  }
  return response;
}

export async function POST(request: Request) {
  const parsed = report.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiJson({ error: { code: "invalid_request", message: "Check the report." } }, 400);
  const existing = readArenaSessionId(request.headers.get("cookie"));
  const sessionId = existing ?? crypto.randomUUID();
  try {
    await submitGalleryReport({
      candidatePublicId: parsed.data.candidateId,
      exampleId: parsed.data.exampleId,
      reason: parsed.data.reason,
      note: parsed.data.note,
      actorUserId: await getAuthenticatedUserId(request),
      sessionHash: hashVoteSession(sessionId),
      ipHmac: hashVoteIp(trustedClientIp(request.headers)),
    });
    return submittedResponse(existing, sessionId);
  } catch (error) {
    if (error instanceof GalleryServiceError && error.code === "not_found") {
      return submittedResponse(existing, sessionId);
    }
    return apiServiceError(error);
  }
}
