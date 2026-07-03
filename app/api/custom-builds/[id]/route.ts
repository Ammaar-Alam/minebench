import {
  customBuildError,
  customBuildNoStoreHeaders,
  customBuildPrivateTerminalHeaders,
  type CustomBuildStatusPayload,
} from "@/lib/custom-builds/api";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { getCustomBuildStatusPayload } from "@/lib/custom-builds/status";

export const runtime = "nodejs";

function canCacheCustomBuildStatus(payload: CustomBuildStatusPayload): boolean {
  if (payload.status === "failed" || payload.status === "canceled") return true;
  if (payload.status !== "succeeded") return false;
  return Object.values(payload.exports).every((entry) => entry.status === "available");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomBuildPublicId(id)) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const payload = await getCustomBuildStatusPayload(id);
  if (!payload) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  return Response.json(payload, {
    headers: canCacheCustomBuildStatus(payload) ? customBuildPrivateTerminalHeaders() : customBuildNoStoreHeaders(),
  });
}
