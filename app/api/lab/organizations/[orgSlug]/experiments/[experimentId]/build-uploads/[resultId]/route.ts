import { NextResponse } from "next/server";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { createStealthBuildUploadTarget } from "@/lib/stealth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export async function POST(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ orgSlug: string; experimentId: string; resultId: string }>;
  },
) {
  const { orgSlug, experimentId, resultId } = await params;
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers });
  }

  try {
    const target = await createStealthBuildUploadTarget(
      { organizationUser: { userId: context.user.id } },
      context.membership.organization.id,
      experimentId,
      resultId,
    );
    return NextResponse.json(target, { headers });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Upload unavailable";
    const status = /not found/i.test(message) ? 404 : /closed|already/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status, headers });
  }
}
