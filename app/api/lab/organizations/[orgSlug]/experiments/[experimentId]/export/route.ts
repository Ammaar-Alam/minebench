import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { canExportStealthVotes, normalizeStealthSlug } from "@/lib/stealth/policy";
import {
  getDeidentifiedStealthVotes,
  serializeDeidentifiedStealthVotes,
} from "@/lib/stealth/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgSlug: string; experimentId: string }> },
) {
  const { orgSlug, experimentId } = await params;
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const experiment = await prisma.stealthExperiment.findUnique({
    where: { id: experimentId },
    select: { organizationId: true, slug: true, exportPolicy: true },
  });
  if (!experiment || experiment.organizationId !== context.membership.organization.id) {
    return NextResponse.json({ error: "Evaluation not found" }, { status: 404 });
  }
  if (
    experiment.exportPolicy !== "DEIDENTIFIED_VOTES" ||
    !canExportStealthVotes(context.membership.role)
  ) {
    return NextResponse.json({ error: "Vote export is not enabled" }, { status: 403 });
  }
  const rows = await getDeidentifiedStealthVotes(experimentId);
  const filename = `${normalizeStealthSlug(experiment.slug)}-votes.csv`;
  return new NextResponse(serializeDeidentifiedStealthVotes(rows), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
