import { NextResponse } from "next/server";
import type { ArenaBuildStreamEvent, ArenaBuildVariant } from "@/lib/arena/types";
import { isArtifactEligibleBuild } from "@/lib/arena/buildDeliveryPolicy";
import {
  ARENA_BUILD_STREAM_HELLO_PAD,
  encodeArenaBuildStreamEvent,
  fetchArenaBuildStreamArtifact,
  iterateArenaBuildChunks,
  planArenaBuildStream,
} from "@/lib/arena/buildStream";
import { deriveArenaBuildLoadHints, pickBuildVariant, prepareArenaBuild } from "@/lib/arena/buildArtifacts";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const PING_INTERVAL_MS = 5_000;
const YIELD_EVERY_MS = 12;
const ARTIFACT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.ARENA_STREAM_ARTIFACT_FETCH_TIMEOUT_MS ?? "3500",
  10,
);

function parseVariant(value: string | null): ArenaBuildVariant {
  return value === "preview" ? "preview" : "full";
}

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}

function createStreamHeaders(
  source: "live" | "artifact",
  opts?: { deliveryClass?: string; estimatedBytes?: number | null },
): Headers {
  const headers = new Headers({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control":
      source === "artifact"
        ? "public, max-age=0, s-maxage=300, stale-while-revalidate=86400, no-transform"
        : "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "x-build-stream-source": source,
  });
  if (opts?.deliveryClass) headers.set("x-build-delivery-class", opts.deliveryClass);
  if (typeof opts?.estimatedBytes === "number" && Number.isFinite(opts.estimatedBytes)) {
    headers.set("x-build-est-bytes", String(Math.floor(opts.estimatedBytes)));
  }
  return headers;
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const controller = new AbortController();
    return fn(controller.signal);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      fn(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: ArenaBuildStreamEvent,
): boolean {
  try {
    controller.enqueue(encodeArenaBuildStreamEvent(event));
    return true;
  } catch {
    return false;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const { buildId } = await params;
  const url = new URL(request.url);
  const variant = parseVariant(url.searchParams.get("variant"));
  const expectedChecksum = url.searchParams.get("checksum")?.trim() || null;

  const meta = await prisma.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
    },
  });

  if (!meta) {
    return NextResponse.json({ error: "Build not found" }, { status: 404 });
  }

  const storedChecksum = meta.voxelSha256?.trim() || null;
  if (expectedChecksum && storedChecksum && expectedChecksum !== storedChecksum) {
    return NextResponse.json(
      {
        error: "Build checksum mismatch",
        expectedChecksum,
        actualChecksum: storedChecksum,
      },
      { status: 409 },
    );
  }

  const shellHints = deriveArenaBuildLoadHints(meta);
  const artifactFetchAllowed =
    url.searchParams.get("artifact") !== "0" && isArtifactEligibleBuild(shellHints.fullEstimatedBytes);

  try {
    if (artifactFetchAllowed) {
      const artifact = await withTimeout(
        (signal) => fetchArenaBuildStreamArtifact(buildId, variant, storedChecksum, { signal }),
        ARTIFACT_FETCH_TIMEOUT_MS,
        "artifact fetch",
      );
      if (artifact?.body) {
        return new Response(artifact.body, {
          headers: createStreamHeaders("artifact", {
            deliveryClass: shellHints.deliveryClass,
            estimatedBytes: shellHints.fullEstimatedBytes,
          }),
        });
      }
    }
  } catch (err) {
    console.warn("arena stream artifact fetch failed", err);
  }

  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
      voxelData: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      voxelStorageEncoding: true,
    },
  });

  if (!build) {
    return NextResponse.json({ error: "Build not found" }, { status: 404 });
  }

  const initialHints = deriveArenaBuildLoadHints(build);
  const initialBlockCount =
    variant === "preview" ? initialHints.previewBlockCount : initialHints.fullBlockCount;
  const initialPlan = planArenaBuildStream({
    totalBlocks: initialBlockCount,
    hints: initialHints,
  });
  const startedAt = performance.now();

  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeClose = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: ArenaBuildStreamEvent) => {
        if (closed) return false;
        const ok = sendEvent(controller, event);
        if (!ok) safeClose();
        return ok;
      };

      send({
        type: "hello",
        buildId,
        variant,
        checksum: storedChecksum,
        serverValidated: false,
        buildLoadHints: initialHints,
        totalBlocks: initialPlan.totalBlocks,
        chunkCount: initialPlan.chunkCount,
        chunkBlockCount: initialPlan.chunkBlockCount,
        estimatedBytes: initialPlan.estimatedBytes,
        source: "live",
        pad: ARENA_BUILD_STREAM_HELLO_PAD,
      });

      ping = setInterval(() => {
        send({ type: "ping", ts: Date.now() });
      }, PING_INTERVAL_MS);

      void (async () => {
        try {
          const prepared = await prepareArenaBuild(build);

          if (expectedChecksum && expectedChecksum !== prepared.checksum) {
            send({
              type: "error",
              message: "Build checksum mismatch",
            });
            safeClose();
            return;
          }

          const voxelBuild = pickBuildVariant(prepared, variant);
          const plan = planArenaBuildStream({
            totalBlocks: voxelBuild.blocks.length,
            hints: prepared.hints,
          });

          send({
            type: "hello",
            buildId,
            variant,
            checksum: prepared.checksum,
            serverValidated: true,
            buildLoadHints: prepared.hints,
            totalBlocks: plan.totalBlocks,
            chunkCount: plan.chunkCount,
            chunkBlockCount: plan.chunkBlockCount,
            estimatedBytes: plan.estimatedBytes,
            source: "live",
          });

          if (plan.totalBlocks <= 0) {
            send({
              type: "complete",
              totalBlocks: 0,
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            });
            safeClose();
            return;
          }

          let yieldedAt = performance.now();
          for (const chunk of iterateArenaBuildChunks(voxelBuild, plan.chunkBlockCount)) {
            if (!send({ type: "chunk", ...chunk })) return;

            const now = performance.now();
            if (now - yieldedAt >= YIELD_EVERY_MS) {
              yieldedAt = now;
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          }

          send({
            type: "complete",
            totalBlocks: plan.totalBlocks,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          });
        } catch (err) {
          send({
            type: "error",
            message: toErrorMessage(err, "Failed to stream build"),
          });
        } finally {
          safeClose();
        }
      })();
    },
    cancel() {
      closed = true;
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: createStreamHeaders("live", {
      deliveryClass: initialHints.deliveryClass,
      estimatedBytes: initialHints.fullEstimatedBytes,
    }),
  });
}
