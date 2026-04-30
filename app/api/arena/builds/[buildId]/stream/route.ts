import { after, NextResponse } from "next/server";
import type { ArenaBuildStreamEvent, ArenaBuildVariant } from "@/lib/arena/types";
import { estimateArenaBuildBytes, isArtifactEligibleBuild } from "@/lib/arena/buildDeliveryPolicy";
import {
  ARENA_BUILD_STREAM_HELLO_PAD,
  createArenaBuildStreamArtifactSignedUrl,
  estimateArenaBuildVariantBytes,
  encodeArenaBuildStreamEvent,
  iterateArenaBuildChunks,
  iterateArenaBuildStreamEvents,
  planArenaBuildStream,
  uploadArenaBuildStreamArtifact,
} from "@/lib/arena/buildStream";
import {
  deriveArenaBuildLoadHints,
  getCachedPreparedArenaBuild,
  getPreparedArenaBuildMetadataUpdate,
  pickBuildVariant,
  prepareArenaBuild,
} from "@/lib/arena/buildArtifacts";
import { getArenaBuildMeta, invalidateArenaBuildMeta } from "@/lib/arena/buildMetaCache";
import { prisma } from "@/lib/prisma";
import { ServerTiming } from "@/lib/serverTiming";
import { trackServerEventInBackground } from "@/lib/analytics.server";

export const runtime = "nodejs";

const PING_INTERVAL_MS = 5_000;
const YIELD_EVERY_MS = 12;
const ARTIFACT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.ARENA_STREAM_ARTIFACT_FETCH_TIMEOUT_MS ?? "3500",
  10,
);
const ARTIFACT_SIGN_URL_TTL_SEC = Number.parseInt(
  process.env.ARENA_STREAM_ARTIFACT_SIGN_URL_TTL_SEC ?? "3600",
  10,
);
const streamArtifactWarmupInflight = new Set<string>();

function createSignedRedirectCacheControl(ttlSeconds: number): string {
  const ttl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : 0;
  const sharedMaxAge = Math.max(0, Math.min(300, ttl - 30));
  if (sharedMaxAge <= 0) return "no-store, no-transform";
  return `public, max-age=0, s-maxage=${sharedMaxAge}, no-transform`;
}

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
        ? createSignedRedirectCacheControl(ARTIFACT_SIGN_URL_TTL_SEC)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkStreamArtifactBytes(events: Iterable<ArenaBuildStreamEvent>) {
  const encoded: Uint8Array[] = [];
  let total = 0;
  for (const event of events) {
    const bytes = encodeArenaBuildStreamEvent(event);
    encoded.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function warmStreamArtifactInBackground(opts: {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string;
  build: ReturnType<typeof pickBuildVariant>;
  buildLoadHints: ReturnType<typeof deriveArenaBuildLoadHints>;
}) {
  const warmupKey = `${opts.buildId}:${opts.variant}:${opts.checksum}`;
  if (streamArtifactWarmupInflight.has(warmupKey)) return;
  streamArtifactWarmupInflight.add(warmupKey);
  try {
    // upload the artifact after serving this live stream
    after(async () => {
      try {
        const bytes = chunkStreamArtifactBytes(
          iterateArenaBuildStreamEvents({
            buildId: opts.buildId,
            variant: opts.variant,
            checksum: opts.checksum,
            build: opts.build,
            buildLoadHints: opts.buildLoadHints,
            source: "artifact",
            serverValidated: true,
            includePad: true,
            durationMs: 0,
          }),
        );
        await uploadArenaBuildStreamArtifact(opts.buildId, opts.variant, opts.checksum, bytes);
      } catch (err) {
        console.warn("arena stream artifact warmup upload failed", err);
      } finally {
        streamArtifactWarmupInflight.delete(warmupKey);
      }
    });
  } catch (err) {
    streamArtifactWarmupInflight.delete(warmupKey);
    const message = toErrorMessage(err, "");
    if (!message.includes("after` was called outside a request scope")) {
      console.warn("arena stream artifact warmup scheduling skipped", err);
    }
  }
}

async function waitForBackpressure(
  controller: ReadableStreamDefaultController<Uint8Array>,
  shouldContinue: () => boolean,
): Promise<boolean> {
  let waits = 0;
  while (shouldContinue()) {
    // slow readers should not make us buffer the whole build
    const desiredSize = controller.desiredSize;
    if (desiredSize == null || desiredSize > 0) return true;
    waits += 1;
    await sleep(Math.min(32, 4 + waits * 2));
  }
  return false;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const timing = new ServerTiming();
  const requestStartedAt = timing.start();
  const { buildId } = await params;
  const url = new URL(request.url);
  const variant = parseVariant(url.searchParams.get("variant"));
  const expectedChecksum = url.searchParams.get("checksum")?.trim() || null;

  // pass expected checksum so the meta cache can detect cross-lambda staleness
  const meta = await getArenaBuildMeta(buildId, expectedChecksum);

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
  const rawFullEstimatedBytes = estimateArenaBuildBytes({
    blockCount: meta.blockCount,
    voxelByteSize: meta.voxelByteSize,
    voxelCompressedByteSize: meta.voxelCompressedByteSize,
  });
  const fullEstimatedBytes = shellHints.fullEstimatedBytes ?? rawFullEstimatedBytes;
  const fullArtifactEligible =
    isArtifactEligibleBuild(shellHints.fullEstimatedBytes) ||
    isArtifactEligibleBuild(rawFullEstimatedBytes);
  const fullRequiresArtifact =
    variant === "full" &&
    (shellHints.deliveryClass === "stream-artifact" || fullArtifactEligible);
  const artifactRequested = url.searchParams.get("artifact") !== "0";
  const artifactFetchAllowed =
    artifactRequested && (variant === "full" ? fullRequiresArtifact : fullArtifactEligible);

  try {
    if (artifactFetchAllowed) {
      const artifactStartedAt = timing.start();
      const artifactSignedUrl = await withTimeout(
        (signal) =>
          createArenaBuildStreamArtifactSignedUrl(buildId, variant, storedChecksum, {
            signal,
            expiresInSec: ARTIFACT_SIGN_URL_TTL_SEC,
          }),
        ARTIFACT_FETCH_TIMEOUT_MS,
        "artifact sign",
      );
      if (artifactSignedUrl) {
        timing.end("artifact_hit", artifactStartedAt);
        timing.end("total", requestStartedAt);
        const shellEstimatedBytes =
          estimateArenaBuildVariantBytes(
            shellHints,
            variant,
            variant === "preview" ? shellHints.previewBlockCount : shellHints.fullBlockCount,
          ) ?? shellHints.fullEstimatedBytes;
        const headers = createStreamHeaders("artifact", {
          deliveryClass: variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass,
          estimatedBytes: shellEstimatedBytes,
        });
        headers.set("Location", artifactSignedUrl);
        timing.apply(headers);
        return new Response(null, {
          status: 307,
          headers,
        });
      }
      timing.end("artifact_miss", artifactStartedAt);
      trackServerEventInBackground("arena_artifact_miss", {
        variant,
        deliveryClass: variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass,
        estimatedBytes:
          estimateArenaBuildVariantBytes(
            shellHints,
            variant,
            variant === "preview" ? shellHints.previewBlockCount : shellHints.fullBlockCount,
          ) ?? 0,
      });
    }
  } catch (err) {
    if (artifactFetchAllowed) {
      trackServerEventInBackground("arena_artifact_fetch_error", {
        variant,
        deliveryClass: variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass,
        estimatedBytes:
          estimateArenaBuildVariantBytes(
            shellHints,
            variant,
            variant === "preview" ? shellHints.previewBlockCount : shellHints.fullBlockCount,
          ) ?? 0,
      });
      timing.add("artifact_error", ARTIFACT_FETCH_TIMEOUT_MS);
    }
    console.warn("arena stream artifact fetch failed", err);
  }

  if (fullRequiresArtifact) {
    // artifact-class builds should not silently fall back to heavy live streams
    timing.end("total", requestStartedAt);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Retry-After": "1",
      "x-build-delivery-class": "stream-artifact",
      "x-build-stream-source": "artifact-required",
    });
    if (typeof fullEstimatedBytes === "number" && Number.isFinite(fullEstimatedBytes)) {
      headers.set("x-build-est-bytes", String(Math.floor(fullEstimatedBytes)));
    }
    timing.apply(headers);
    return NextResponse.json(
      {
        error: "Full build artifact is still warming. Try again shortly.",
        retryVia: "artifact",
      },
      { status: 503, headers },
    );
  }

  const cachedPrepared = getCachedPreparedArenaBuild(buildId, storedChecksum);
  const build = cachedPrepared
    ? null
    : await prisma.build.findUnique({
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

  if (!cachedPrepared && !build) {
    return NextResponse.json({ error: "Build not found" }, { status: 404 });
  }

  const initialHints = cachedPrepared?.hints ?? deriveArenaBuildLoadHints(build!);
  const initialBlockCount =
    variant === "preview" ? initialHints.previewBlockCount : initialHints.fullBlockCount;
  const initialPlan = planArenaBuildStream({
    totalBlocks: initialBlockCount,
    hints: initialHints,
    variant,
  });
  const startedAt = performance.now();

  let ping: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  timing.end("total", requestStartedAt);
  const responseHeaders = createStreamHeaders("live", {
    deliveryClass: variant === "preview" ? initialHints.initialDeliveryClass : initialHints.deliveryClass,
    estimatedBytes: estimateArenaBuildVariantBytes(initialHints, variant, initialBlockCount),
  });
  timing.apply(responseHeaders);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (ping) clearInterval(ping);
        request.signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        closed = true;
        cleanup();
      };
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener("abort", abort, { once: true });
      }

      const safeClose = () => {
        if (closed) {
          cleanup();
          return;
        }
        closed = true;
        cleanup();
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
        // early hello lets the client show progress before prepare finishes
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
          if (closed || request.signal.aborted) return;
          // heavy parse starts after the response stream is open
          const prepared = cachedPrepared ?? (await prepareArenaBuild(build!, { signal: request.signal }));
          if (closed || request.signal.aborted) return;

          if (!cachedPrepared) {
            await prisma.build
              .update({
                where: { id: buildId },
                data: getPreparedArenaBuildMetadataUpdate(prepared),
              })
              .catch((err) => {
                console.warn("arena stream metadata update failed", err);
              });
            invalidateArenaBuildMeta(buildId);
          }

          if (expectedChecksum && expectedChecksum !== prepared.checksum) {
            send({
              type: "error",
              message: "Build checksum mismatch",
            });
            safeClose();
            return;
          }

          const voxelBuild = pickBuildVariant(prepared, variant);
          if (
            variant === "full" &&
            prepared.hints.deliveryClass === "stream-artifact" &&
            prepared.checksum
          ) {
            warmStreamArtifactInBackground({
              buildId,
              variant,
              checksum: prepared.checksum,
              build: voxelBuild,
              buildLoadHints: prepared.hints,
            });
          }
          const plan = planArenaBuildStream({
            totalBlocks: voxelBuild.blocks.length,
            hints: prepared.hints,
            variant,
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
            const canSend = await waitForBackpressure(
              controller,
              () => !closed && !request.signal.aborted,
            );
            if (!canSend) return;
            if (!send({ type: "chunk", ...chunk })) return;

            const now = performance.now();
            if (now - yieldedAt >= YIELD_EVERY_MS) {
              yieldedAt = now;
              await sleep(0);
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

  return new Response(stream, { headers: responseHeaders });
}
