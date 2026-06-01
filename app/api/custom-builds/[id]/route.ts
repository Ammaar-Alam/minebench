import { customBuildError, customBuildNoStoreHeaders, customBuildPrivateTerminalHeaders } from "@/lib/custom-builds/api";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { getCustomBuildStatusPayload } from "@/lib/custom-builds/status";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomBuildPublicId(id)) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const payload = await getCustomBuildStatusPayload(id);
  if (!payload) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const terminal = payload.status === "succeeded" || payload.status === "failed" || payload.status === "canceled";
  return Response.json(payload, {
    headers: terminal ? customBuildPrivateTerminalHeaders() : customBuildNoStoreHeaders(),
  });
}
