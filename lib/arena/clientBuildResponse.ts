import { decodeBinaryArtifact, isBinaryArtifact } from "@/lib/arena/binaryArtifact";
import type {
  ArenaBuildLoadHints,
  ArenaBuildStreamEvent,
  ArenaBuildVariant,
} from "@/lib/arena/types";
import {
  appendPackedVoxelBlocks,
  createPackedVoxelBlocks,
  packVoxelBlocks,
  reservePackedVoxelBlocks,
  type PackedVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const STREAM_FIRST_EVENT_TIMEOUT_MS = readPositiveInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_FIRST_EVENT_TIMEOUT_MS,
  6_000,
);
const STREAM_STALL_TIMEOUT_MS = readPositiveInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_STALL_TIMEOUT_MS,
  10_000,
);
const STREAM_HARD_TIMEOUT_MS = readPositiveInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_HARD_TIMEOUT_MS,
  35_000,
);

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isGzipChunk(chunk: Uint8Array): boolean {
  return chunk.length >= 2 && chunk[0] === GZIP_MAGIC_0 && chunk[1] === GZIP_MAGIC_1;
}

function byteAt(chunks: readonly Uint8Array[], targetIndex: number): number | null {
  let offset = targetIndex;
  for (const chunk of chunks) {
    if (offset < chunk.length) return chunk[offset];
    offset -= chunk.length;
  }
  return null;
}

export function isGzipStreamPrefix(chunks: readonly Uint8Array[]): boolean {
  return byteAt(chunks, 0) === GZIP_MAGIC_0 && byteAt(chunks, 1) === GZIP_MAGIC_1;
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Compressed build artifact is not supported by this browser.");
  }
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const decompressor = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const stream = new Blob([body]).stream().pipeThrough(decompressor);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readBuildVariantJson<T>(res: Response): Promise<T> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = isGzipChunk(bytes) ? await gunzipBytes(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

// A request for the binary artifact can still be answered with JSON: the
// binary object is written alongside the JSON one rather than replacing it, so
// a miss falls back. The body is therefore identified by what it is, not by
// what was asked for.
export type BuildVariantArtifact<T> =
  | { kind: "json"; value: T }
  | { kind: "binary"; envelope: Record<string, unknown>; blocks: PackedVoxelBlocks };

export type BuildVariantArtifactReadEvent =
  | { stage: "body_complete"; bytes: number }
  | { stage: "inflate_complete"; bytes: number; compressed: boolean }
  | { stage: "binary_decode_complete"; blockCount: number }
  | { stage: "json_decode_complete" };

export async function readBuildVariantArtifact<T>(
  res: Response,
  options?: { onStage?: (event: BuildVariantArtifactReadEvent) => void },
): Promise<BuildVariantArtifact<T>> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  options?.onStage?.({ stage: "body_complete", bytes: bytes.byteLength });
  const compressed = isGzipChunk(bytes);
  const body = compressed ? await gunzipBytes(bytes) : bytes;
  options?.onStage?.({
    stage: "inflate_complete",
    bytes: body.byteLength,
    compressed,
  });
  if (isBinaryArtifact(body)) {
    const { envelope, blocks } = decodeBinaryArtifact(body);
    options?.onStage?.({ stage: "binary_decode_complete", blockCount: blocks.count });
    return { kind: "binary", envelope, blocks };
  }
  const value = JSON.parse(new TextDecoder().decode(body)) as T;
  options?.onStage?.({ stage: "json_decode_complete" });
  return { kind: "json", value };
}

export type BuildVariantStreamResponse = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  serverValidated: boolean;
  buildLoadHints?: ArenaBuildLoadHints;
  voxelBuild: RenderableVoxelBuild;
};

export type BuildStreamProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
  chunkIndex: number | null;
  chunkCount: number | null;
};

export class IncompleteBuildStreamError extends Error {
  constructor(message = "Build stream ended before all blocks loaded") {
    super(message);
    this.name = "IncompleteBuildStreamError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isVariant(value: unknown): value is ArenaBuildVariant {
  return value === "full" || value === "preview";
}

function isDeliveryClass(value: unknown): value is ArenaBuildLoadHints["deliveryClass"] {
  return (
    value === "inline" ||
    value === "snapshot" ||
    value === "stream-live" ||
    value === "stream-artifact"
  );
}

function isBuildLoadHints(value: unknown): value is ArenaBuildLoadHints {
  if (!isRecord(value)) return false;
  return (
    isVariant(value.initialVariant) &&
    isDeliveryClass(value.initialDeliveryClass) &&
    isDeliveryClass(value.deliveryClass) &&
    isNonNegativeInt(value.fullBlockCount) &&
    isNonNegativeInt(value.previewBlockCount) &&
    isNonNegativeInt(value.previewStride) &&
    (value.initialEstimatedBytes === null || isNonNegativeInt(value.initialEstimatedBytes)) &&
    (value.fullEstimatedBytes === null || isNonNegativeInt(value.fullEstimatedBytes))
  );
}

// Parsing JSON produces one object per block. Packing at the delivery boundary
// lets that array go instead of keeping it alive for as long as a lane holds
// the build, which on a matchup means two of them at once.
export function packDeliveredBuild(
  build: RenderableVoxelBuild,
): RenderableVoxelBuild;
export function packDeliveredBuild(
  build: RenderableVoxelBuild | null,
): RenderableVoxelBuild | null;
export function packDeliveredBuild(
  build: RenderableVoxelBuild | null | undefined,
): RenderableVoxelBuild | null | undefined;
export function packDeliveredBuild(
  build: RenderableVoxelBuild | null | undefined,
): RenderableVoxelBuild | null | undefined {
  if (!build) return build;
  if (build.packed || !Array.isArray(build.blocks) || build.blocks.length === 0) {
    return build;
  }
  return { ...build, blocks: [], packed: packVoxelBlocks(build.blocks) };
}

export type BuildVariantPayloadResult = {
  payload: BuildVariantStreamResponse;
  servedFormat: "binary" | "json";
  bodyBytes: number | null;
  compressed: boolean;
};

export type ReadBuildVariantPayloadOptions = {
  fallbackIdentity?: {
    buildId?: string;
    variant?: ArenaBuildVariant;
    checksum?: string | null;
  };
  onStage?: (event: BuildVariantArtifactReadEvent) => void;
};

export async function readBuildVariantPayload(
  res: Response,
  optionsOrOnStage?:
    | ReadBuildVariantPayloadOptions
    | ((event: BuildVariantArtifactReadEvent) => void),
): Promise<BuildVariantPayloadResult> {
  const options: ReadBuildVariantPayloadOptions =
    typeof optionsOrOnStage === "function"
      ? { onStage: optionsOrOnStage }
      : optionsOrOnStage ?? {};

  let bodyBytes: number | null = null;
  let compressed = false;
  const artifact = await readBuildVariantArtifact<BuildVariantStreamResponse>(res, {
    onStage(event) {
      if (event.stage === "body_complete") bodyBytes = event.bytes;
      if (event.stage === "inflate_complete") {
        compressed = event.compressed;
      }
      options.onStage?.(event);
    },
  });

  if (artifact.kind === "json") {
    const raw = artifact.value;
    if (!isRecord(raw)) throw new Error("Malformed build response JSON");
    const rawVariant = typeof raw.variant === "string" ? raw.variant : undefined;
    if (rawVariant && options.fallbackIdentity?.variant && rawVariant !== options.fallbackIdentity.variant) {
      throw new Error("Contradictory variant in build response");
    }
    const variant = (isVariant(rawVariant) ? rawVariant : options.fallbackIdentity?.variant) as ArenaBuildVariant;
    if (!isVariant(variant)) {
      throw new Error("Invalid or missing variant in build response");
    }
    const buildId =
      typeof raw.buildId === "string" && raw.buildId.length > 0
        ? raw.buildId
        : (options.fallbackIdentity?.buildId ?? "");
    const checksum =
      typeof raw.checksum === "string"
        ? raw.checksum
        : (raw.checksum === null ? null : (options.fallbackIdentity?.checksum ?? null));
    const serverValidated = typeof raw.serverValidated === "boolean" ? raw.serverValidated : false;
    const buildLoadHints = isBuildLoadHints(raw.buildLoadHints) ? raw.buildLoadHints : undefined;

    const voxelBuild = (isRecord(raw.voxelBuild) ? raw.voxelBuild : raw) as RenderableVoxelBuild;
    const packedVoxelBuild = packDeliveredBuild(voxelBuild) ?? {
      version: "1.0",
      blocks: [],
      packed: createPackedVoxelBlocks(0),
    };

    return {
      payload: {
        buildId,
        variant,
        checksum,
        serverValidated,
        buildLoadHints,
        voxelBuild: packedVoxelBuild,
      },
      servedFormat: "json",
      bodyBytes,
      compressed,
    };
  }

  const envelope = (artifact.envelope ?? {}) as Partial<BuildVariantStreamResponse> & {
    version?: string;
  };
  const expectedVariant = options.fallbackIdentity?.variant;
  if (envelope.variant && expectedVariant && envelope.variant !== expectedVariant) {
    throw new Error("Contradictory variant in build response");
  }

  const resolvedVariant = (envelope.variant ?? expectedVariant) as ArenaBuildVariant;
  if (!isVariant(resolvedVariant)) {
    throw new Error("Invalid or missing variant in build response");
  }

  const buildId =
    typeof envelope.buildId === "string" && envelope.buildId.length > 0
      ? envelope.buildId
      : (options.fallbackIdentity?.buildId ?? "");

  const checksum =
    typeof envelope.checksum === "string"
      ? envelope.checksum
      : (envelope.checksum === null ? null : (options.fallbackIdentity?.checksum ?? null));

  return {
    payload: {
      buildId,
      variant: resolvedVariant,
      checksum,
      serverValidated: Boolean(envelope.serverValidated),
      buildLoadHints: isBuildLoadHints(envelope.buildLoadHints)
        ? envelope.buildLoadHints
        : undefined,
      voxelBuild: { version: "1.0", blocks: [], packed: artifact.blocks },
    },
    servedFormat: "binary",
    bodyBytes,
    compressed,
  };
}

function isVoxelBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInt(value.x) &&
    value.x <= 32_767 &&
    isNonNegativeInt(value.y) &&
    value.y <= 32_767 &&
    isNonNegativeInt(value.z) &&
    value.z <= 32_767 &&
    typeof value.type === "string" &&
    value.type.length > 0
  );
}

function parseBuildStreamEvent(line: string): ArenaBuildStreamEvent | null {
  if (!line.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Malformed build stream event");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Malformed build stream event");
  }
  if (value.type === "ping") {
    if (!isNonNegativeNumber(value.ts)) throw new Error("Malformed build stream ping");
    return value as ArenaBuildStreamEvent;
  }
  if (value.type === "error") {
    if (typeof value.message !== "string") throw new Error("Malformed build stream error");
    return value as ArenaBuildStreamEvent;
  }
  if (value.type === "hello") {
    const valid =
      typeof value.buildId === "string" &&
      value.buildId.length > 0 &&
      isVariant(value.variant) &&
      (value.checksum === null || typeof value.checksum === "string") &&
      typeof value.serverValidated === "boolean" &&
      isNonNegativeInt(value.totalBlocks) &&
      isNonNegativeInt(value.chunkCount) &&
      isNonNegativeInt(value.chunkBlockCount) &&
      (value.estimatedBytes === null || isNonNegativeInt(value.estimatedBytes)) &&
      (value.source === "live" || value.source === "artifact") &&
      (value.buildLoadHints === undefined || isBuildLoadHints(value.buildLoadHints));
    if (!valid) throw new Error("Malformed build stream hello");
    return value as ArenaBuildStreamEvent;
  }
  if (value.type === "chunk") {
    if (
      !isNonNegativeInt(value.index) ||
      !isNonNegativeInt(value.chunkCount) ||
      !isNonNegativeInt(value.receivedBlocks) ||
      !isNonNegativeInt(value.totalBlocks) ||
      !Array.isArray(value.blocks)
    ) {
      throw new Error("Malformed build stream chunk");
    }
    if (!value.blocks.every(isVoxelBlock)) throw new Error("Invalid build stream block");
    return value as ArenaBuildStreamEvent;
  }
  if (value.type === "complete") {
    if (!isNonNegativeInt(value.totalBlocks) || !isNonNegativeNumber(value.durationMs)) {
      throw new Error("Malformed build stream completion");
    }
    return value as ArenaBuildStreamEvent;
  }
  throw new Error("Unknown build stream event");
}

async function readWithTimeout<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    read().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function readBuildVariantStream(
  response: Response,
  options?: {
    signal?: AbortSignal;
    onStage?: (stage: "body_complete" | "stream_decode_complete") => void;
    onProgress?: (
      build: RenderableVoxelBuild,
      progress: BuildStreamProgress,
      metadata: { serverValidated: boolean },
    ) => void;
  },
): Promise<BuildVariantStreamResponse> {
  if (!response.body) throw new IncompleteBuildStreamError("Build stream is unavailable");

  const startedAt = Date.now();
  const firstEventDeadline = startedAt + STREAM_FIRST_EVENT_TIMEOUT_MS;
  const hardDeadline = startedAt + STREAM_HARD_TIMEOUT_MS;
  let sawFirstEvent = false;
  const timedRead = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const now = Date.now();
    const phaseRemaining = sawFirstEvent
      ? STREAM_STALL_TIMEOUT_MS
      : firstEventDeadline - now;
    const hardRemaining = hardDeadline - now;
    if (hardRemaining <= 0) throw new Error("Build stream hard timeout");
    if (phaseRemaining <= 0) {
      throw new Error(
        sawFirstEvent ? "Build stream stalled" : "Build stream timed out before the first event",
      );
    }
    const hardTimeout = hardRemaining <= phaseRemaining;
    return readWithTimeout(
      () => reader.read(),
      Math.min(phaseRemaining, hardRemaining),
      hardTimeout
        ? "Build stream hard timeout"
        : sawFirstEvent
          ? "Build stream stalled"
          : "Build stream timed out before the first event",
      options?.signal,
    );
  };

  const sourceReader = response.body.getReader();
  let sourceReaderOwned = true;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const initialChunks: Uint8Array[] = [];
    let initialByteCount = 0;
    while (initialByteCount < 2) {
      const initial = await timedRead(sourceReader);
      if (initial.done) break;
      if (initial.value?.length) {
        initialChunks.push(initial.value);
        initialByteCount += initial.value.length;
      }
    }
    if (initialChunks.length === 0) {
      throw new IncompleteBuildStreamError("Build stream ended before any data loaded");
    }

    const compressed = isGzipStreamPrefix(initialChunks);
    if (compressed) {
      if (typeof DecompressionStream !== "function") {
        throw new Error("Compressed build artifact is not supported by this browser.");
      }
    }

    const replay = streamFromInitialChunks(initialChunks, sourceReader);
    sourceReaderOwned = false;
    if (compressed) {
      reader = replay
        .pipeThrough(
          new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
        )
        .getReader();
    } else {
      reader = replay.getReader();
    }

    const packed = createPackedVoxelBlocks(0);
    const voxelBuild: RenderableVoxelBuild = { version: "1.0", blocks: [], packed };
    const decoder = new TextDecoder();
    let buffer = "";
    let buildId = "";
    let variant: ArenaBuildVariant | null = null;
    let checksum: string | null = null;
    let serverValidated = false;
    let buildLoadHints: ArenaBuildLoadHints | undefined;
    let totalBlocks: number | null = null;
    let chunkCount: number | null = null;
    let nextChunkIndex = 1;
    let complete = false;

    const processLine = (line: string) => {
      const event = parseBuildStreamEvent(line);
      if (!event) return;
      sawFirstEvent = true;
      if (complete) throw new Error("Build stream continued after completion");
      if (event.type === "ping") return;
      if (event.type === "error") throw new Error(event.message || "Build stream failed");
      if (event.type === "hello") {
        if (packed.count > 0) throw new Error("Build stream hello arrived after block data");
        if (variant && (event.buildId !== buildId || event.variant !== variant)) {
          throw new Error("Build stream hello metadata is inconsistent");
        }
        buildId = event.buildId;
        variant = event.variant;
        checksum = event.checksum?.trim() || checksum;
        serverValidated = serverValidated || event.serverValidated;
        buildLoadHints = event.buildLoadHints ?? buildLoadHints;
        totalBlocks = event.totalBlocks;
        chunkCount = event.chunkCount;
        reservePackedVoxelBlocks(packed, totalBlocks);
        options?.onProgress?.(
          voxelBuild,
          {
            receivedBlocks: packed.count,
            totalBlocks,
            chunkIndex: null,
            chunkCount,
          },
          { serverValidated },
        );
        return;
      }
      if (!variant || totalBlocks === null || chunkCount === null) {
        throw new Error("Build stream data arrived before hello");
      }
      if (event.type === "chunk") {
        if (
          event.index !== nextChunkIndex ||
          event.chunkCount !== chunkCount ||
          event.totalBlocks !== totalBlocks ||
          event.index > chunkCount
        ) {
          throw new Error("Build stream chunk metadata is inconsistent");
        }
        appendPackedVoxelBlocks(packed, event.blocks);
        nextChunkIndex += 1;
        if (event.receivedBlocks !== packed.count || packed.count > totalBlocks) {
          throw new Error("Build stream block count is inconsistent");
        }
        options?.onProgress?.(
          voxelBuild,
          {
            receivedBlocks: packed.count,
            totalBlocks,
            chunkIndex: event.index,
            chunkCount,
          },
          { serverValidated },
        );
        return;
      }
      if (event.totalBlocks !== totalBlocks) {
        throw new Error("Build stream completion metadata is inconsistent");
      }
      complete = true;
    };

    while (true) {
      const { done, value } = await timedRead(reader);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    options?.onStage?.("body_complete");
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    if (!complete || !variant || totalBlocks === null || packed.count !== totalBlocks) {
      throw new IncompleteBuildStreamError();
    }
    if (nextChunkIndex - 1 !== chunkCount) {
      throw new IncompleteBuildStreamError("Build stream ended before all chunks loaded");
    }
    options?.onStage?.("stream_decode_complete");
    return {
      buildId,
      variant,
      checksum,
      serverValidated,
      buildLoadHints,
      voxelBuild,
    };
  } catch (error) {
    try {
      if (reader) await reader.cancel(error);
      else if (sourceReaderOwned) await sourceReader.cancel(error);
    } catch {
      // the source may already have failed
    }
    throw error;
  } finally {
    if (reader) reader.releaseLock();
    if (sourceReaderOwned) sourceReader.releaseLock();
  }
}

export function streamFromInitialChunks(
  initialChunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let replayIndex = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (replayIndex < initialChunks.length) {
          controller.enqueue(initialChunks[replayIndex]);
          replayIndex += 1;
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          if (value) {
            controller.enqueue(value);
          }
        } catch (err) {
          release();
          controller.error(err);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // already canceled
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
