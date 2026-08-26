import { GalleryServiceError } from "@/lib/gallery/service";
import { GenerationServiceError } from "@/lib/generations/service";

export const PRIVATE_API_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
} as const;

const STATUS_BY_CODE: Record<string, number> = {
  authentication_required: 401,
  forbidden: 403,
  account_suspended: 403,
  not_found: 404,
  already_finished: 409,
  duplicate_unavailable: 409,
  generation_mismatch: 409,
  generation_not_available: 409,
  nickname_required: 409,
  public_examples_require_confirmation: 409,
  selected_candidate: 409,
  storage_failsafe: 409,
  artifact_deletion_pending: 503,
  missing_provider_key: 401,
};

export function apiJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PRIVATE_API_HEADERS });
}

export function apiServiceError(error: unknown): Response {
  if (error instanceof GalleryServiceError || error instanceof GenerationServiceError) {
    return apiJson(
      { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
      STATUS_BY_CODE[error.code] ?? 400,
    );
  }
  console.error("Gallery API request failed", error);
  return apiJson({ error: { code: "internal_error", message: "Request failed." } }, 500);
}
