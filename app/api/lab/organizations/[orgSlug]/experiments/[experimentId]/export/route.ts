import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { canExportStealthVotes, normalizeStealthSlug } from "@/lib/stealth/policy";
import {
  type DeidentifiedStealthVoteCursor,
  getDeidentifiedStealthVotePage,
  serializeDeidentifiedStealthVotes,
} from "@/lib/stealth/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
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
  const filename = `${normalizeStealthSlug(experiment.slug)}-votes.csv`;
  const encoder = new TextEncoder();
  let cursor: DeidentifiedStealthVoteCursor | null = null;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(serializeDeidentifiedStealthVotes([])));
    },
    async pull(controller) {
      if (finished) return;
      if (request.signal.aborted) {
        finished = true;
        controller.close();
        return;
      }
      try {
        const page = await getDeidentifiedStealthVotePage(experimentId, cursor);
        if (page.rows.length > 0) {
          controller.enqueue(encoder.encode(serializeDeidentifiedStealthVotes(page.rows, false)));
        }
        cursor = page.nextCursor;
        if (!cursor) {
          finished = true;
          controller.close();
        }
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
