"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SandboxGifExportButton,
  type SandboxGifExportTarget,
} from "@/components/sandbox/SandboxGifExportButton";
import type { VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { formatVoxelLoadingMessage } from "@/components/voxel/VoxelLoadingHud";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { ErrorState } from "@/components/ErrorState";
import type {
  ArenaBuildDeliveryClass,
  ArenaBuildLoadHints,
  ArenaBuildRef,
  ArenaBuildStreamEvent,
  ArenaBuildVariant,
} from "@/lib/arena/types";
import type { VoxelBuild } from "@/lib/voxel/types";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;
type Slot = "a" | "b";

type BenchmarkPromptOption = {
  id: string;
  text: string;
  modelCount: number;
};

type BenchmarkModelOption = {
  key: string;
  provider: string;
  displayName: string;
  eloRating: number;
};

type BenchmarkBuild = {
  buildId: string;
  checksum: string | null;
  serverValidated: boolean;
  buildRef: ArenaBuildRef;
  previewRef: ArenaBuildRef;
  buildLoadHints: ArenaBuildLoadHints;
  voxelBuild: unknown | null;
  model: BenchmarkModelOption;
  metrics: {
    blockCount: number;
    generationTimeMs: number;
  };
};

type BenchmarkResponse = {
  settings: {
    gridSize: number;
    palette: string;
    mode: string;
  };
  prompts: BenchmarkPromptOption[];
  selectedPrompt: {
    id: string;
    text: string;
  } | null;
  models: BenchmarkModelOption[];
  selectedModels: {
    a: string | null;
    b: string | null;
  };
  builds: {
    a: BenchmarkBuild | null;
    b: BenchmarkBuild | null;
  };
};

type BuildVariantResponse = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  serverValidated: boolean;
  buildLoadHints?: ArenaBuildLoadHints;
  voxelBuild: VoxelBuild;
};

type BuildStreamProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
  chunkIndex: number | null;
  chunkCount: number | null;
};

type FetchBuildVariantStreamOptions = {
  signal?: AbortSignal;
  allowSnapshotFallback?: boolean;
  allowLiveFallback?: boolean;
  onProgress?: (
    build: VoxelBuild,
    progress: BuildStreamProgress,
    meta: { serverValidated: boolean },
  ) => void;
};

type SlotHydrationState = {
  buildId: string | null;
  build: unknown | null;
  phase: "idle" | "loading" | "ready" | "error";
  progress: {
    receivedBlocks: number;
    totalBlocks: number | null;
  } | null;
  error: string | null;
  serverValidated: boolean;
};

type CachedBuild = {
  build: unknown;
  serverValidated: boolean;
  variant: ArenaBuildVariant;
};

const DEFAULT_MODEL_A = "openai_gpt_5_5";
const DEFAULT_MODEL_B = "openai_gpt_5_5_pro";
const SNAPSHOT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_SNAPSHOT_TIMEOUT_MS ?? "12000",
  10,
);
const STREAM_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_REQUEST_TIMEOUT_MS ?? "12000",
  10,
);
const STREAM_FIRST_EVENT_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_FIRST_EVENT_TIMEOUT_MS ?? "6000",
  10,
);
const STREAM_STALL_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_STALL_TIMEOUT_MS ?? "10000",
  10,
);
const STREAM_HARD_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_HARD_TIMEOUT_MS ?? "35000",
  10,
);
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

type TimeoutSignal = {
  signal: AbortSignal;
  cleanup: () => void;
};

function makeTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutSignal {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer != null) window.clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

async function readWithTimeout<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? window.setTimeout(() => {
            cleanup();
            reject(new Error("Build stream stalled"));
          }, timeoutMs)
        : null;
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      if (timer != null) window.clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    read().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function SelectChevron() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function providerLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Google";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "minimax") return "MiniMax";
  if (provider === "xai") return "xAI";
  if (provider === "zai") return "Z.AI";
  if (provider === "qwen") return "Qwen";
  if (provider === "meta") return "Meta";
  return provider;
}

function toGridSize(gridSize: number): GridSize {
  if (gridSize === 64 || gridSize === 256 || gridSize === 512) return gridSize;
  return 256;
}

function toPalette(palette: string): Palette {
  return palette === "advanced" ? "advanced" : "simple";
}

function createEmptySlotState(): SlotHydrationState {
  return {
    buildId: null,
    build: null,
    phase: "idle",
    progress: null,
    error: null,
    serverValidated: false,
  };
}

function toSlotProgressTotal(build: BenchmarkBuild | null): number | null {
  if (!build) return null;
  if (build.metrics.blockCount > 0) return build.metrics.blockCount;
  const hints = build.buildLoadHints;
  if (hints && hints.fullBlockCount > 0) return hints.fullBlockCount;
  return null;
}

function formatBuildLoadingMessage(progress: SlotHydrationState["progress"]): string {
  return formatVoxelLoadingMessage("Retrieving build", progress);
}

function isGzipChunk(chunk: Uint8Array): boolean {
  return chunk.length >= 2 && chunk[0] === GZIP_MAGIC_0 && chunk[1] === GZIP_MAGIC_1;
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Compressed build artifact is not supported by this browser.");
  }
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const decompressor = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const stream = new Blob([body]).stream().pipeThrough(decompressor);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readBuildVariantJson(res: Response): Promise<BuildVariantResponse> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = isGzipChunk(bytes) ? await gunzipBytes(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(body)) as BuildVariantResponse;
}

async function fetchBenchmarkResponse(args: {
  promptId?: string;
  modelA?: string;
  modelB?: string;
  signal?: AbortSignal;
}): Promise<BenchmarkResponse> {
  const params = new URLSearchParams();
  if (args.promptId) params.set("promptId", args.promptId);
  if (args.modelA) params.set("modelA", args.modelA);
  if (args.modelB) params.set("modelB", args.modelB);

  const query = params.toString();
  const url = query ? `/api/sandbox/benchmark?${query}` : "/api/sandbox/benchmark";
  const res = await fetch(url, { method: "GET", cache: "no-store", signal: args.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || "Failed to load benchmark comparison data";
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error?: unknown }).error === "string"
      ) {
        message = (parsed as { error: string }).error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as BenchmarkResponse;
}

async function fetchBuildVariantSnapshot(
  ref: ArenaBuildRef,
  signal?: AbortSignal,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS,
): Promise<BuildVariantResponse> {
  const url = new URL(`/api/arena/builds/${encodeURIComponent(ref.buildId)}`, window.location.origin);
  url.searchParams.set("variant", ref.variant);
  if (ref.checksum) url.searchParams.set("checksum", ref.checksum);
  const timed = makeTimeoutSignal(signal, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: timed.signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return await readBuildVariantJson(res);
  } finally {
    timed.cleanup();
  }
}

function parseArenaBuildStreamLine(line: string): ArenaBuildStreamEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ArenaBuildStreamEvent;
  } catch {
    return null;
  }
}

async function fetchBuildVariantStreamOnce(
  ref: ArenaBuildRef,
  useArtifact: boolean,
  opts?: FetchBuildVariantStreamOptions,
): Promise<BuildVariantResponse> {
  const url = new URL(
    `/api/arena/builds/${encodeURIComponent(ref.buildId)}/stream`,
    window.location.origin,
  );
  url.searchParams.set("variant", ref.variant);
  if (ref.checksum) url.searchParams.set("checksum", ref.checksum);
  if (!useArtifact) url.searchParams.set("artifact", "0");

  const requestTimed = makeTimeoutSignal(opts?.signal, STREAM_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: requestTimed.signal,
    });
  } finally {
    requestTimed.cleanup();
  }
  if (!res.ok) throw new Error(await res.text());

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.body || !contentType.includes("application/x-ndjson")) {
    return (await res.json()) as BuildVariantResponse;
  }

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const startedAt = performance.now();

    let resolvedVariant: ArenaBuildVariant = ref.variant;
    let checksum: string | null = ref.checksum ?? null;
    let serverValidated = false;
    let buildLoadHints: ArenaBuildLoadHints | undefined;
    let totalBlocks: number | null = null;
    let hasComplete = false;
    let sawFirstEvent = false;

    const streamedBlocks: VoxelBuild["blocks"] = [];

    const emitProgress = (progress: BuildStreamProgress) => {
      if (!opts?.onProgress) return;
      opts.onProgress(
        {
          version: "1.0",
          blocks: streamedBlocks,
        },
        progress,
        { serverValidated },
      );
    };

    const processLine = (line: string) => {
      const event = parseArenaBuildStreamLine(line);
      if (!event) return;

      if (event.type === "ping") {
        sawFirstEvent = true;
        return;
      }
      if (event.type === "error") {
        throw new Error(event.message || "Build stream failed");
      }
      if (event.type === "hello") {
        sawFirstEvent = true;
        resolvedVariant = event.variant;
        checksum = event.checksum ?? checksum;
        serverValidated = serverValidated || event.serverValidated;
        totalBlocks = event.totalBlocks || totalBlocks;
        buildLoadHints = event.buildLoadHints ?? buildLoadHints;
        if (streamedBlocks.length === 0) {
          emitProgress({
            receivedBlocks: 0,
            totalBlocks,
            chunkIndex: null,
            chunkCount: event.chunkCount ?? null,
          });
        }
        return;
      }
      if (event.type === "chunk") {
        sawFirstEvent = true;
        if (Array.isArray(event.blocks) && event.blocks.length > 0) {
          for (const block of event.blocks) {
            streamedBlocks.push(block);
          }
        }
        totalBlocks = event.totalBlocks || totalBlocks;
        emitProgress({
          receivedBlocks: event.receivedBlocks,
          totalBlocks,
          chunkIndex: event.index,
          chunkCount: event.chunkCount,
        });
        return;
      }
      if (event.type === "complete") {
        hasComplete = true;
        totalBlocks = event.totalBlocks || totalBlocks;
      }
    };

    while (true) {
      if (performance.now() - startedAt > STREAM_HARD_TIMEOUT_MS) {
        throw new Error("Build stream hard timeout");
      }

      const { done, value } = await readWithTimeout(
        () => reader.read(),
        sawFirstEvent ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_EVENT_TIMEOUT_MS,
        opts?.signal,
      );
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    const announcedTotal =
      typeof totalBlocks === "number" && Number.isFinite(totalBlocks) && totalBlocks >= 0
        ? totalBlocks
        : null;
    const streamLooksComplete =
      hasComplete && (announcedTotal == null || streamedBlocks.length >= announcedTotal);

    if (!streamLooksComplete) {
      if (opts?.allowSnapshotFallback === false) {
        throw new Error("Build stream ended before all blocks loaded");
      }
      return fetchBuildVariantSnapshot(ref, opts?.signal);
    }

    return {
      buildId: ref.buildId,
      variant: resolvedVariant,
      checksum,
      serverValidated,
      buildLoadHints,
      voxelBuild: {
        version: "1.0",
        blocks: streamedBlocks,
      },
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw err;
  }
}

async function fetchBuildVariantStream(
  ref: ArenaBuildRef,
  opts?: FetchBuildVariantStreamOptions,
): Promise<BuildVariantResponse> {
  let lastError: unknown = null;
  const attempts: Array<() => Promise<BuildVariantResponse>> = [
    () => fetchBuildVariantStreamOnce(ref, true, opts),
    ...(opts?.allowSnapshotFallback === false
      ? []
      : [
          () => fetchBuildVariantSnapshot(ref, opts?.signal),
          () => fetchBuildVariantSnapshot(ref, opts?.signal, SNAPSHOT_FETCH_TIMEOUT_MS * 2),
        ]),
    ...(opts?.allowLiveFallback
      ? [() => fetchBuildVariantStreamOnce(ref, false, opts)]
      : []),
  ];

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError" && opts?.signal?.aborted) {
        throw err;
      }
      lastError = err;
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("Failed to retrieve build"));
}

function getInitialDeliveryClass(hints: ArenaBuildLoadHints | undefined): ArenaBuildDeliveryClass | undefined {
  return hints?.initialDeliveryClass ?? hints?.deliveryClass;
}

function getHydrationDeliveryClass(
  hints: ArenaBuildLoadHints | undefined,
  variant: ArenaBuildVariant,
): ArenaBuildDeliveryClass | undefined {
  return variant === "preview" ? getInitialDeliveryClass(hints) : hints?.deliveryClass;
}

function getBuildCacheKey(ref: ArenaBuildRef): string {
  return `${ref.buildId}:${ref.variant}:${ref.checksum ?? "none"}`;
}

function getVoxelBlockCount(build: unknown): number {
  if (!build || typeof build !== "object") return 0;
  const blocks = (build as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? blocks.length : 0;
}

export function SandboxBenchmark() {
  const [promptId, setPromptId] = useState("");
  const [modelPair, setModelPair] = useState({ a: DEFAULT_MODEL_A, b: DEFAULT_MODEL_B });
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionReloading, setSelectionReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotState, setSlotState] = useState<Record<Slot, SlotHydrationState>>({
    a: createEmptySlotState(),
    b: createEmptySlotState(),
  });

  const requestIdRef = useRef(0);
  const hydrationRunIdRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const slotAbortRef = useRef<Record<Slot, AbortController | null>>({ a: null, b: null });
  const buildCacheRef = useRef<Map<string, CachedBuild>>(new Map());

  const viewerARef = useRef<VoxelViewerHandle | null>(null);
  const viewerBRef = useRef<VoxelViewerHandle | null>(null);

  const setCachedBuild = useCallback((ref: ArenaBuildRef, value: CachedBuild) => {
    const cache = buildCacheRef.current;
    const cacheKey = getBuildCacheKey(ref);
    if (cache.has(cacheKey)) cache.delete(cacheKey);
    cache.set(cacheKey, value);
    while (cache.size > 8) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
  }, []);

  const getCachedBuild = useCallback((ref: ArenaBuildRef): CachedBuild | null => {
    return buildCacheRef.current.get(getBuildCacheKey(ref)) ?? null;
  }, []);

  const clearVisibleBuilds = useCallback(() => {
    for (const slot of ["a", "b"] as const) {
      slotAbortRef.current[slot]?.abort();
      slotAbortRef.current[slot] = null;
    }
    hydrationRunIdRef.current += 1;
    setSlotState({
      a: createEmptySlotState(),
      b: createEmptySlotState(),
    });
  }, []);

  const runLoad = useCallback(
    async (
      args: {
        promptId?: string;
        modelA?: string;
        modelB?: string;
      },
      opts?: { initial?: boolean; bypassCache?: boolean },
    ) => {
      const requestId = ++requestIdRef.current;
      loadAbortRef.current?.abort();
      const loadAbort = new AbortController();
      loadAbortRef.current = loadAbort;
      const isInitial = Boolean(opts?.initial);
      if (opts?.bypassCache) buildCacheRef.current.clear();
      if (isInitial) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const nextData = await fetchBenchmarkResponse({ ...args, signal: loadAbort.signal });
        if (requestId !== requestIdRef.current) return;

        setSelectionReloading(false);
        setData(nextData);
        setPromptId(nextData.selectedPrompt?.id ?? "");
        setModelPair({
          a: nextData.selectedModels.a ?? "",
          b: nextData.selectedModels.b ?? "",
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (requestId !== requestIdRef.current) return;
        const message =
          err instanceof Error ? err.message : "Failed to load benchmark comparison data";
        setSelectionReloading(false);
        setError(message);
        setSlotState({
          a: { ...createEmptySlotState(), phase: "error", error: message },
          b: { ...createEmptySlotState(), phase: "error", error: message },
        });
      } finally {
        if (requestId !== requestIdRef.current) return;
        if (loadAbortRef.current === loadAbort) {
          loadAbortRef.current = null;
        }
        if (isInitial) setLoading(false);
        else setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void runLoad(
      {
        modelA: DEFAULT_MODEL_A,
        modelB: DEFAULT_MODEL_B,
      },
      { initial: true },
    );
  }, [runLoad]);

  useEffect(() => {
    const runId = ++hydrationRunIdRef.current;
    const effectControllers: Partial<Record<Slot, AbortController>> = {};
    const abortRef = slotAbortRef.current;

    for (const slot of ["a", "b"] as const) {
      abortRef[slot]?.abort();
      abortRef[slot] = null;
    }

    if (!data) {
      setSlotState({
        a: createEmptySlotState(),
        b: createEmptySlotState(),
      });
      return;
    }

    const nextState: Record<Slot, SlotHydrationState> = {
      a: createEmptySlotState(),
      b: createEmptySlotState(),
    };
    const hydrateQueue: Array<{ slot: Slot; lane: BenchmarkBuild }> = [];

    for (const slot of ["a", "b"] as const) {
      const lane = data.builds[slot];
      if (!lane) {
        nextState[slot] = {
          ...createEmptySlotState(),
          phase: "error",
          error: "No seeded build found for this model/prompt pair.",
        };
        continue;
      }

      const cached = getCachedBuild(lane.buildRef);
      if (cached?.variant === "full") {
        nextState[slot] = {
          buildId: lane.buildId,
          build: cached.build,
          phase: "ready",
          progress: {
            receivedBlocks: lane.metrics.blockCount,
            totalBlocks: lane.metrics.blockCount,
          },
          error: null,
          serverValidated: cached.serverValidated,
        };
        continue;
      }

      if (lane.voxelBuild) {
        const serverValidated = Boolean(lane.serverValidated);
        if (lane.buildLoadHints.initialVariant === "full") {
          setCachedBuild(lane.buildRef, {
            build: lane.voxelBuild,
            serverValidated,
            variant: "full",
          });
          nextState[slot] = {
            buildId: lane.buildId,
            build: lane.voxelBuild,
            phase: "ready",
            progress: {
              receivedBlocks: lane.metrics.blockCount,
              totalBlocks: lane.metrics.blockCount,
            },
            error: null,
            serverValidated,
          };
          continue;
        }

        // preview payloads are just placeholders so always hydrate the full ref
        nextState[slot] = {
          buildId: lane.buildId,
          build: lane.voxelBuild,
          phase: "loading",
          progress: {
            receivedBlocks:
              getVoxelBlockCount(lane.voxelBuild) || lane.buildLoadHints.previewBlockCount || 0,
            totalBlocks: toSlotProgressTotal(lane),
          },
          error: null,
          serverValidated,
        };
        hydrateQueue.push({ slot, lane });
        continue;
      }

      nextState[slot] = {
        buildId: lane.buildId,
        build: null,
        phase: "loading",
        progress: {
          receivedBlocks: 0,
          totalBlocks: toSlotProgressTotal(lane),
        },
        error: null,
        serverValidated: false,
      };
      hydrateQueue.push({ slot, lane });
    }

    setSlotState(nextState);

    for (const { slot, lane } of hydrateQueue) {
      const controller = new AbortController();
      effectControllers[slot] = controller;
      abortRef[slot] = controller;

      void (async () => {
        try {
          const deliveryClass = getHydrationDeliveryClass(lane.buildLoadHints, lane.buildRef.variant);
          const allowSnapshotFallback = deliveryClass !== "stream-artifact";
          const streamFetch = () =>
            fetchBuildVariantStream(lane.buildRef, {
              signal: controller.signal,
              allowSnapshotFallback,
              allowLiveFallback: deliveryClass !== "stream-artifact",
              onProgress: (progressiveBuild, progress, meta) => {
                if (hydrationRunIdRef.current !== runId) return;
                setSlotState((prev) => {
                  const current = prev[slot];
                  if (!current || current.buildId !== lane.buildId) return prev;

                  const sameProgress =
                    current.progress?.receivedBlocks === progress.receivedBlocks &&
                    current.progress?.totalBlocks === progress.totalBlocks;
                  const sameValidation = current.serverValidated === meta.serverValidated;
                  if (sameProgress && sameValidation && current.build === progressiveBuild) {
                    return prev;
                  }

                  const currentBlockCount = getVoxelBlockCount(current.build);
                  const nextBuild =
                    progress.receivedBlocks > currentBlockCount ? progressiveBuild : current.build;

                  return {
                    ...prev,
                    [slot]: {
                      ...current,
                      phase: "loading",
                      build: nextBuild,
                      progress: {
                        receivedBlocks: progress.receivedBlocks,
                        totalBlocks: progress.totalBlocks,
                      },
                      error: null,
                      serverValidated: current.serverValidated || meta.serverValidated,
                    },
                  };
                });
              },
            });
          const payload =
            deliveryClass === "snapshot" || deliveryClass === "inline"
              ? await fetchBuildVariantSnapshot(lane.buildRef, controller.signal).catch(streamFetch)
              : await streamFetch();

          if (hydrationRunIdRef.current !== runId) return;

          setCachedBuild(lane.buildRef, {
            build: payload.voxelBuild,
            serverValidated: payload.serverValidated,
            variant: payload.variant ?? lane.buildRef.variant,
          });

          setSlotState((prev) => {
            const current = prev[slot];
            if (!current || current.buildId !== lane.buildId) return prev;
            return {
              ...prev,
              [slot]: {
                ...current,
                build: payload.voxelBuild,
                phase: "ready",
                progress: {
                  receivedBlocks: lane.metrics.blockCount,
                  totalBlocks: lane.metrics.blockCount,
                },
                error: null,
                serverValidated: current.serverValidated || payload.serverValidated,
              },
            };
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") return;
          if (hydrationRunIdRef.current !== runId) return;
          setSlotState((prev) => {
            const current = prev[slot];
            if (!current || current.buildId !== lane.buildId) return prev;
            return {
              ...prev,
              [slot]: {
                ...current,
                phase: "error",
                error: err instanceof Error ? err.message : "Failed to load build",
              },
            };
          });
        }
      })();
    }

    return () => {
      for (const slot of ["a", "b"] as const) {
        const controller = effectControllers[slot];
        controller?.abort();
        if (abortRef[slot] === controller) {
          abortRef[slot] = null;
        }
      }
    };
  }, [data, getCachedBuild, setCachedBuild]);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, BenchmarkModelOption[]>();
    for (const model of data?.models ?? []) {
      const key = providerLabel(model.provider);
      const rows = groups.get(key) ?? [];
      rows.push(model);
      groups.set(key, rows);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, models]) => ({ label, models }));
  }, [data?.models]);

  function handlePromptChange(nextPromptId: string) {
    setPromptId(nextPromptId);
    setSelectionReloading(true);
    clearVisibleBuilds();
    setData((prev) => {
      if (!prev) return prev;
      const selectedPrompt = prev.prompts.find((p) => p.id === nextPromptId);
      return {
        ...prev,
        selectedPrompt: selectedPrompt ? { id: selectedPrompt.id, text: selectedPrompt.text } : prev.selectedPrompt,
        builds: { a: null, b: null },
      };
    });
    void runLoad(
      {
        promptId: nextPromptId,
        modelA: modelPair.a,
        modelB: modelPair.b,
      },
      { initial: false },
    );
  }

  function handleModelChange(slot: "a" | "b", modelKey: string) {
    if (!modelKey) return;
    const other = slot === "a" ? modelPair.b : modelPair.a;
    if (modelKey === other) return;
    const nextPair = slot === "a" ? { a: modelKey, b: other } : { a: other, b: modelKey };
    setModelPair(nextPair);
    setSelectionReloading(true);
    clearVisibleBuilds();
    setData((prev) =>
      prev
        ? {
            ...prev,
            selectedModels: nextPair,
            builds: { a: null, b: null },
          }
        : prev,
    );
    void runLoad(
      {
        promptId,
        modelA: nextPair.a,
        modelB: nextPair.b,
      },
      { initial: false },
    );
  }

  function handleRandomPrompt() {
    if (!data || data.prompts.length === 0) return;
    const candidates = data.prompts.filter((p) => p.id !== promptId);
    const pool = candidates.length > 0 ? candidates : data.prompts;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    handlePromptChange(pick.id);
  }

  function navigatePrompt(delta: 1 | -1) {
    if (!data || data.prompts.length === 0) return;
    const len = data.prompts.length;
    const currentIndex = data.prompts.findIndex((p) => p.id === promptId);
    const base = currentIndex >= 0 ? currentIndex : 0;
    const next = data.prompts[(base + delta + len) % len];
    if (!next) return;
    handlePromptChange(next.id);
  }

  const selectedPromptText =
    data?.prompts.find((p) => p.id === promptId)?.text ?? data?.selectedPrompt?.text ?? "";
  const selectedPromptIndex = data?.prompts.findIndex((p) => p.id === promptId) ?? -1;
  const totalPrompts = data?.prompts.length ?? 0;
  const canNavigatePrompts = totalPrompts > 1;
  const gridSize = toGridSize(data?.settings.gridSize ?? 256);
  const palette = toPalette(data?.settings.palette ?? "simple");

  const compareTargets: SandboxGifExportTarget[] = data
    ? (["a", "b"] as const)
        .map((slot) => {
          const build = data.builds[slot];
          const laneState = slotState[slot];
          if (!build || laneState.phase !== "ready" || !laneState.build) return null;
          const viewerRef = slot === "a" ? viewerARef : viewerBRef;
          return {
            viewerRef,
            modelName: build.model.displayName,
            company: providerLabel(build.model.provider),
            blockCount: build.metrics.blockCount,
          };
        })
        .filter((target): target is SandboxGifExportTarget => Boolean(target))
    : [];

  const cards = data
    ? (["a", "b"] as const).map((slot) => {
        const build = data.builds[slot];
        const laneState = slotState[slot];
        const selectedModelKey = slot === "a" ? modelPair.a : modelPair.b;
        const fallbackModel = data.models.find((m) => m.key === selectedModelKey);
        const model = build?.model ?? fallbackModel;
        const viewerRef = slot === "a" ? viewerARef : viewerBRef;
        const title = model ? model.displayName : slot === "a" ? "Model A" : "Model B";

        const hasRenderableBuild = Boolean(laneState.build);
        const isHydrating = laneState.phase === "loading" || (!build && selectionReloading);
        const loadingMessage = isHydrating
          ? formatBuildLoadingMessage(laneState.progress)
          : undefined;

        const laneError =
          laneState.phase === "error" && !selectionReloading
            ? laneState.error ?? "Failed to load build"
            : !build && !selectionReloading
              ? "No seeded build found for this model/prompt pair."
              : undefined;

        return (
          <VoxelViewerCard
            key={`${slot}:${build?.buildId ?? "none"}:${model?.key ?? selectedModelKey}`}
            title={title}
            subtitle={
              model ? (
                <span className="inline-flex items-center gap-2 text-xs text-muted">
                  <span className="uppercase tracking-[0.08em]">{providerLabel(model.provider)}</span>
                  <span className="font-mono">Elo {Math.round(model.eloRating)}</span>
                </span>
              ) : (
                <span className="text-xs text-muted">Select a model</span>
              )
            }
            voxelBuild={laneState.build}
            skipValidation={laneState.serverValidated || Boolean(build?.serverValidated)}
            gridSize={gridSize}
            palette={palette}
            animateIn
            isLoading={isHydrating}
            loadingMessage={loadingMessage}
            loadingProgress={isHydrating ? laneState.progress ?? undefined : undefined}
            viewerRef={viewerRef}
            actions={
              hasRenderableBuild && build && model ? (
                <SandboxGifExportButton
                  targets={[
                    {
                      viewerRef,
                      modelName: model.displayName,
                      company: providerLabel(model.provider),
                      blockCount: build.metrics.blockCount,
                    },
                  ]}
                  promptText={selectedPromptText}
                  cancelKey={`${promptId}:${slot}:${build.buildId}:${model.key}`}
                  iconOnly
                  label="Export GIF"
                />
              ) : null
            }
            metrics={
              build
                ? {
                    blockCount: build.metrics.blockCount,
                    generationTimeMs: build.metrics.generationTimeMs,
                    warnings: [],
                  }
                : undefined
            }
            error={laneError}
          />
        );
      })
    : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="mb-panel p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="font-display text-2xl font-semibold tracking-tight">
              Compare arena builds directly
            </div>
            <div className="text-sm text-muted">
              Pick a curated benchmark prompt and compare two models side by side.
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:gap-2">
            <SandboxGifExportButton
              targets={compareTargets}
              promptText={selectedPromptText}
              cancelKey={`${promptId}:${modelPair.a}:${modelPair.b}:${data?.builds.a?.buildId ?? "none"}:${data?.builds.b?.buildId ?? "none"}`}
              label="Export GIF"
              className="h-8 px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs"
            />

            <button
              type="button"
              className="mb-btn mb-btn-ghost h-8 rounded-full px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs"
              onClick={() => {
                setSelectionReloading(true);
                clearVisibleBuilds();
                void runLoad(
                  {
                    promptId,
                    modelA: modelPair.a,
                    modelB: modelPair.b,
                  },
                  { initial: false, bypassCache: true },
                );
              }}
              disabled={loading || refreshing}
              title="Refresh builds"
            >
              <span className="inline-flex items-center gap-1.5">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                  fill="none"
                >
                  <path
                    d="M20 12a8 8 0 1 1-2.34-5.66"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.7"
                  />
                  <path
                    d="M20 4v6h-6"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.7"
                  />
                </svg>
                <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
              </span>
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-4">
            <ErrorState
              error={new Error(error)}
              title="Couldn't load benchmark"
              hint={error}
              onRetry={() =>
                void runLoad(
                  {
                    promptId,
                    modelA: modelPair.a || undefined,
                    modelB: modelPair.b || undefined,
                  },
                  { initial: true },
                )
              }
              retrying={loading || refreshing}
            />
          </div>
        ) : null}

        {/* Current prompt — shown once, as the hero. Prev/Random/Next below
           form the prompt-navigation cluster so Random's scope is unambiguous. */}
        <div className="mt-5">
          <p className="text-[17px] font-medium leading-snug text-fg sm:text-lg">
            {selectedPromptText || "Loading benchmark prompt…"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted/80">
            <span>{gridSize}</span>
            <span className="text-muted/35">·</span>
            <span>{palette}</span>
            <span className="text-muted/35">·</span>
            <span>{data?.settings.mode ?? "precise"}</span>
            {totalPrompts > 0 ? (
              <>
                <span className="text-muted/35">·</span>
                {/* The counter IS the picker: native <select> overlaid on the
                   counter label. No extra chrome — the existing "N of M"
                   indicator gains a chevron and click behaviour. */}
                <label
                  className={`relative -my-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors focus-within:bg-bg/70 focus-within:text-fg focus-within:ring-2 focus-within:ring-accent/35 ${
                    loading || refreshing || totalPrompts <= 1
                      ? "cursor-not-allowed opacity-80"
                      : "cursor-pointer hover:bg-bg/60 hover:text-fg"
                  }`}
                >
                  <span>
                    {(selectedPromptIndex >= 0 ? selectedPromptIndex + 1 : 1)} / {totalPrompts}
                  </span>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-3 w-3 text-muted/60"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m7 10 5 5 5-5" />
                  </svg>
                  <select
                    aria-label="Jump to a specific benchmark prompt"
                    className="absolute inset-0 cursor-pointer opacity-0 focus:outline-none"
                    value={promptId}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    disabled={loading || refreshing || totalPrompts <= 1}
                  >
                    {(data?.prompts ?? []).map((p, i) => (
                      <option key={p.id} value={p.id}>
                        {i + 1}. {p.text}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Browse benchmark prompts">
            <button
              type="button"
              aria-label="Previous prompt"
              className="mb-btn mb-btn-ghost h-9 w-9 rounded-full p-0"
              onClick={() => navigatePrompt(-1)}
              disabled={loading || refreshing || !canNavigatePrompts}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m14 6-6 6 6 6" />
              </svg>
            </button>
            <button
              type="button"
              className="mb-btn mb-btn-ghost h-9 rounded-full px-3 text-xs"
              onClick={handleRandomPrompt}
              disabled={loading || refreshing || !canNavigatePrompts}
              title="Pick a random prompt"
            >
              <span className="inline-flex items-center gap-1.5">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
                  <rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
                  <circle cx="9" cy="9" r="1.1" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.1" fill="currentColor" />
                  <circle cx="15" cy="15" r="1.1" fill="currentColor" />
                </svg>
                <span>Random</span>
              </span>
            </button>
            <button
              type="button"
              aria-label="Next prompt"
              className="mb-btn mb-btn-ghost h-9 w-9 rounded-full p-0"
              onClick={() => navigatePrompt(1)}
              disabled={loading || refreshing || !canNavigatePrompts}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m10 6 6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Model A</span>
            <div className="relative">
              <select
                className="mb-field h-11 w-full appearance-none pr-10"
                value={modelPair.a}
                onChange={(e) => handleModelChange("a", e.target.value)}
                disabled={loading || refreshing || (data?.models.length ?? 0) < 2}
              >
                {modelGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((model) => (
                      <option key={model.key} value={model.key} disabled={model.key === modelPair.b}>
                        {model.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <SelectChevron />
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Model B</span>
            <div className="relative">
              <select
                className="mb-field h-11 w-full appearance-none pr-10"
                value={modelPair.b}
                onChange={(e) => handleModelChange("b", e.target.value)}
                disabled={loading || refreshing || (data?.models.length ?? 0) < 2}
              >
                {modelGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((model) => (
                      <option key={model.key} value={model.key} disabled={model.key === modelPair.a}>
                        {model.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <SelectChevron />
            </div>
          </label>
        </div>
      </div>

      {loading && !data ? (
        <div className="mb-panel p-10 text-center text-sm text-muted">Loading benchmark builds…</div>
      ) : null}

      {!loading && data ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{cards}</div> : null}
    </div>
  );
}
