import { customBuildError, customBuildNoStoreHeaders } from "@/lib/custom-builds/api";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { listCustomBuildEventsAfter } from "@/lib/custom-builds/events";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function parseAfter(req: Request): number {
  const url = new URL(req.url);
  const queryAfter = Number.parseInt(url.searchParams.get("after") ?? "", 10);
  if (Number.isFinite(queryAfter) && queryAfter >= 0) return queryAfter;
  const headerAfter = Number.parseInt(req.headers.get("last-event-id") ?? "", 10);
  return Number.isFinite(headerAfter) && headerAfter >= 0 ? headerAfter : 0;
}

function sseEvent(event: { seq: number; type: string; data: unknown }) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomBuildPublicId(id)) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const customBuild = await prisma.customBuild.findUnique({
    where: { publicId: id },
    select: { id: true, status: true },
  });
  if (!customBuild) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let after = parseAfter(req);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", close, { once: true });
      controller.enqueue(encoder.encode(`: hello ${Date.now()}\n\n`));

      while (!closed) {
        const events = await listCustomBuildEventsAfter(customBuild.id, after);
        for (const event of events) {
          if (closed) return;
          controller.enqueue(encoder.encode(sseEvent(event)));
          after = event.seq;
          if (["complete", "failed", "canceled"].includes(event.type)) {
            close();
            return;
          }
        }

        const latest = await prisma.customBuild.findUnique({
          where: { id: customBuild.id },
          select: {
            status: true,
            jobs: {
              where: {
                type: "export",
                status: { in: ["queued", "running"] },
              },
              select: { id: true },
              take: 1,
            },
          },
        });
        const terminalWithNoPendingExports =
          latest &&
          (latest.status === "failed" ||
            latest.status === "canceled" ||
            (latest.status === "succeeded" && latest.jobs.length === 0));
        if (terminalWithNoPendingExports) {
          const terminalEvents = await listCustomBuildEventsAfter(customBuild.id, after);
          for (const event of terminalEvents) {
            controller.enqueue(encoder.encode(sseEvent(event)));
            after = event.seq;
          }
          close();
          return;
        }

        controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...customBuildNoStoreHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
