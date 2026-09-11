import { isGridSize, type GridSize } from "@/lib/ai/limits";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { readBuildVariantPayload } from "@/lib/arena/clientBuildResponse";
import { getPalette } from "@/lib/blocks/palettes";
import type { SavedGenerationPayload } from "@/lib/generations/service";
import {
  createLocalVoxelWorld,
  LocalVoxelWorldSourceError,
  type LocalVoxelWorldProgress,
  type LocalVoxelWorldOwnership,
} from "@/lib/voxel/localWorld";
import type { RenderableVoxelBuild } from "@/lib/voxel/packedBlocks";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import { parseVoxelWorldManifest } from "@/lib/voxel/world";

type Palette = "simple" | "advanced";
type ParseSource = "build-json" | "tool-call";

type ResolvedSettings = {
  gridSize: GridSize;
  palette: Palette;
};

type ParseRequest = {
  type: "parse";
  requestId: number;
  rawText: string;
  file?: File;
  gridSize: GridSize;
  palette: Palette;
  maxBlocksByGrid: Record<GridSize, number>;
};

type CancelRequest = {
  type: "cancel";
  requestId?: number;
  shutdown?: boolean;
};

type WorkerRequest = ParseRequest | CancelRequest;

type ProgressMessage = {
  type: "progress";
  requestId: number;
  deltaBlocks: VoxelBlock[];
  receivedBlocks: number;
  totalBlocks: number | null;
  stage?: LocalVoxelWorldProgress["stage"];
  bytesRead?: number;
  totalBytes?: number;
  processedBlocks?: number;
  processedTotalBlocks?: number;
};

type CompleteMessage = {
  type: "complete";
  requestId: number;
  voxelBuild: RenderableVoxelBuild;
  warnings: string[];
  receivedBlocks: number;
  totalBlocks: number | null;
  source: ParseSource;
  resolved: ResolvedSettings;
  localWorld?: LocalVoxelWorldOwnership;
};

type ErrorMessage = {
  type: "error";
  requestId: number;
  message: string;
};

type WorkerResponse = ProgressMessage | CompleteMessage | ErrorMessage;

const EMIT_INTERVAL_MS = 48;
const EMIT_BLOCK_THRESHOLD = 6_000;
const CANCELLED_ERROR = "__cancelled__";

let activeRequestId = -1;
let activeAbortController: AbortController | null = null;
let shuttingDown = false;
const pendingParses = new Set<Promise<void>>();

function isCancelled(requestId: number): boolean {
  return activeRequestId !== requestId;
}

function findNumericField(text: string, field: string): number | null {
  const re = new RegExp(`"${field}"\\s*:\\s*(\\d+)`, "i");
  const match = re.exec(text);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function findArrayStart(text: string, field: string): number {
  const token = `"${field}"`;
  let inString = false;
  let escaped = false;

  for (let i = 0; i <= text.length - token.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch !== '"') continue;

    if (text.startsWith(token, i)) {
      let j = i + token.length;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      if (text[j] !== ":") {
        inString = true;
        escaped = false;
        continue;
      }
      j += 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === "[") return j;
      inString = true;
      escaped = false;
      continue;
    }

    inString = true;
    escaped = false;
  }

  return -1;
}

function parseBlockSlice(slice: string): VoxelBlock | null {
  try {
    const parsed = JSON.parse(slice) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as { x?: unknown; y?: unknown; z?: unknown; type?: unknown };
    const x = typeof obj.x === "number" ? Math.trunc(obj.x) : null;
    const y = typeof obj.y === "number" ? Math.trunc(obj.y) : null;
    const z = typeof obj.z === "number" ? Math.trunc(obj.z) : null;
    const type = typeof obj.type === "string" ? obj.type : null;
    if (x == null || y == null || z == null || !type) return null;
    return { x, y, z, type };
  } catch {
    return null;
  }
}

const PRIMITIVE_ARRAY_RE = /"lines"\s*:\s*\[|"boxes"\s*:\s*\[/i;

type ToolCallInput = {
  code: string;
  gridSize: GridSize;
  palette: Palette;
  seed?: number;
};

function trimOuterWhitespace(text: string): string {
  if (!text) return "";
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  if (start === 0 && end === text.length) return text;
  return text.slice(start, end);
}

function parseToolCallInput(value: unknown): ToolCallInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as { tool?: unknown; input?: unknown };
  if (obj.tool !== "voxel.exec") return null;
  if (!obj.input || typeof obj.input !== "object" || Array.isArray(obj.input)) return null;

  const input = obj.input as { code?: unknown; gridSize?: unknown; palette?: unknown; seed?: unknown };
  if (typeof input.code !== "string" || input.code.trim().length === 0) return null;
  if (!isGridSize(input.gridSize)) return null;
  if (input.palette !== "simple" && input.palette !== "advanced") return null;
  if (input.seed != null && (!Number.isInteger(input.seed) || !Number.isFinite(input.seed))) return null;

  return {
    code: input.code,
    gridSize: input.gridSize,
    palette: input.palette,
    seed: typeof input.seed === "number" ? input.seed : undefined,
  };
}

function parseTopLevelJsonObjects(text: string, limit = 4): unknown[] {
  const parsed: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          parsed.push(JSON.parse(text.slice(start, i + 1)) as unknown);
        } catch {
          // ignore malformed top-level object and continue scanning.
        }
        start = -1;
        if (parsed.length >= limit) break;
      }
    }
  }

  return parsed;
}

type ExecutionResult = { build: unknown; warnings: string[]; generationId?: string };

async function executeVoxelExecToolCall(input: ToolCallInput, signal: AbortSignal): Promise<ExecutionResult> {
  const response = await fetch("/api/local/voxel-exec", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });
  return readExecutionResponse(response, signal);
}

function executionDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readQueuedExecution(generation: SavedGenerationPayload, signal: AbortSignal): Promise<ExecutionResult> {
  if (!generation || typeof generation.id !== "string" || !generation.id) {
    throw new Error("Import returned an invalid generation");
  }
  const generationId = generation.id;
  const statusPath = `/api/generations/${encodeURIComponent(generationId)}`;
  const viewerPath = `${statusPath}/artifacts/viewer`;
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    if (generation.status === "failed" || generation.status === "canceled") {
      throw new Error(generation.error?.message ?? "Import could not be completed");
    }
    if (!["queued", "running", "succeeded"].includes(generation.status)) {
      throw new Error("Import returned an invalid status");
    }
    try {
      const ready = generation.status === "succeeded";
      const response = await fetch(ready ? viewerPath : statusPath, { cache: "no-store", signal });
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new TypeError(`Import temporarily unavailable (${response.status})`);
        }
        return readExecutionResponse(response, signal);
      }
      if (ready) {
        const result = await readBuildVariantPayload(response, {
          fallbackIdentity: { buildId: generationId, variant: "full", checksum: generation.sha256 },
        });
        return {
          build: result.payload.voxelBuild,
          warnings: Array.isArray(generation.warnings) ? generation.warnings.filter((warning) => typeof warning === "string") : [],
          generationId,
        };
      }
      const body = await response.json() as { generation?: SavedGenerationPayload };
      if (!body?.generation || body.generation.id !== generationId) throw new Error("Import returned an invalid generation");
      generation = body.generation;
      failures = 0;
    } catch (error) {
      if (!(error instanceof TypeError) || signal.aborted || ++failures >= 5) throw error;
    }
    if (failures || generation.status === "queued" || generation.status === "running") {
      await executionDelay(failures ? Math.min(10_000, 1_000 * 2 ** (failures - 1)) : 2500, signal);
    }
  }
}

async function readExecutionResponse(response: Response, signal: AbortSignal): Promise<ExecutionResult> {
  const bodyText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as unknown) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : null;
    const serverError = typeof error === "string" ? error
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message : "";

    if (response.status === 429) {
      const retryAfterRaw = response.headers.get("retry-after") ?? "";
      const retryAfter = Number.parseInt(retryAfterRaw, 10);
      const waitHint =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? `Wait ${retryAfter}s and try again.`
          : "Wait a moment and try again.";
      throw new Error(`Too many render requests. ${waitHint}`);
    }

    if (response.status === 403) {
      throw new Error(serverError || "Local renderer is unavailable right now.");
    }

    if (response.status === 413) {
      throw new Error(serverError || "Code payload is too large for local execution.");
    }

    const message =
      serverError
        ? serverError
        : `Tool execution failed (${response.status})`;
    throw new Error(message);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Tool execution returned an invalid response");
  }

  if (response.status === 202) {
    return readQueuedExecution((parsed as { generation: SavedGenerationPayload }).generation, signal);
  }

  const build = (parsed as { build?: unknown }).build;
  if (!build) {
    throw new Error("Tool execution returned no build");
  }

  const rawWarnings = (parsed as { warnings?: unknown }).warnings;
  const warnings =
    Array.isArray(rawWarnings) && rawWarnings.every((w) => typeof w === "string")
      ? (rawWarnings as string[])
      : [];

  return { build, warnings };
}

function readServerWorld(build: unknown, generationId?: string): RenderableVoxelBuild | null {
  if (!build || typeof build !== "object" || !("world" in build)) return null;
  const world = build.world as { manifest?: unknown; partBaseUrl?: unknown } | null;
  if (!world || typeof world.partBaseUrl !== "string") throw new Error("World delivery URL is missing");
  const url = new URL(world.partBaseUrl, self.location.origin);
  const expectedPath = generationId ? `/api/generations/${encodeURIComponent(generationId)}/artifacts/viewer` : "/api/local/voxel-exec";
  if (url.origin !== self.location.origin || url.pathname !== expectedPath || (generationId && (url.search || url.hash || url.username || url.password))) {
    throw new Error("Invalid local world delivery URL");
  }
  const parsed = parseVoxelWorldManifest(world.manifest);
  if (!parsed.ok) throw new Error(parsed.error);
  return { version: "1.0", blocks: [], world: { manifest: parsed.value, partBaseUrl: world.partBaseUrl } };
}

function streamBlocksFromText(
  request: ParseRequest,
  postProgress: (msg: ProgressMessage) => void,
): { blocks: VoxelBlock[]; totalBlocks: number | null } | null {
  const text = request.rawText;
  if (PRIMITIVE_ARRAY_RE.test(text)) {
    return null;
  }
  const blocksStart = findArrayStart(text, "blocks");
  if (blocksStart < 0) return null;

  const totalHint = findNumericField(text, "blockCount");
  const blocks: VoxelBlock[] = [];
  let deltaBlocks: VoxelBlock[] = [];

  let inString = false;
  let escaped = false;
  let arrayDepth = 0;
  let objectDepth = 0;
  let objectStart = -1;
  let started = false;
  let lastEmitAt = performance.now();

  const maybeEmitProgress = (force = false) => {
    if (deltaBlocks.length === 0) return;
    const now = performance.now();
    if (!force && deltaBlocks.length < EMIT_BLOCK_THRESHOLD && now - lastEmitAt < EMIT_INTERVAL_MS) {
      return;
    }

    postProgress({
      type: "progress",
      requestId: request.requestId,
      deltaBlocks,
      receivedBlocks: blocks.length,
      totalBlocks: totalHint,
    });
    deltaBlocks = [];
    lastEmitAt = now;
  };

  for (let i = blocksStart; i < text.length; i += 1) {
    if (isCancelled(request.requestId)) {
      throw new Error(CANCELLED_ERROR);
    }

    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (!started) {
      if (ch === "[") {
        started = true;
        arrayDepth = 1;
      }
      continue;
    }

    if (ch === "[") {
      if (objectDepth === 0) {
        arrayDepth += 1;
      }
      continue;
    }

    if (ch === "]") {
      if (objectDepth === 0) {
        arrayDepth -= 1;
        if (arrayDepth <= 0) break;
      }
      continue;
    }

    if (ch === "{") {
      if (objectDepth === 0) objectStart = i;
      objectDepth += 1;
      continue;
    }

    if (ch === "}") {
      if (objectDepth === 0) continue;
      objectDepth -= 1;
      if (objectDepth === 0 && objectStart >= 0) {
        const block = parseBlockSlice(text.slice(objectStart, i + 1));
        if (block) {
          blocks.push(block);
          deltaBlocks.push(block);
        }
        objectStart = -1;
        maybeEmitProgress(false);
      }
      continue;
    }
  }

  maybeEmitProgress(true);
  return { blocks, totalBlocks: totalHint };
}

async function runParse(request: ParseRequest) {
  activeAbortController?.abort();
  const abortController = new AbortController();
  activeAbortController = abortController;
  activeRequestId = request.requestId;

  let raw = trimOuterWhitespace(request.rawText);
  if (!raw && !request.file) {
    const message: ErrorMessage = {
      type: "error",
      requestId: request.requestId,
      message: "Paste a JSON object first.",
    };
    postMessage(message satisfies WorkerResponse);
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    return;
  }

  const postProgress = (msg: ProgressMessage) => {
    if (isCancelled(request.requestId)) return;
    postMessage(msg satisfies WorkerResponse);
  };
  let lastWorldProgressAt = -Infinity;
  const postWorldProgress = (progress: LocalVoxelWorldProgress) => {
    if (isCancelled(request.requestId)) return;
    const now = performance.now();
    const complete =
      progress.stage === "building" &&
      progress.processedBlocks !== undefined &&
      progress.totalBlocks !== undefined &&
      progress.processedBlocks >= progress.totalBlocks;
    const readingComplete =
      progress.stage === "reading" &&
      progress.bytesRead !== undefined &&
      progress.totalBytes !== undefined &&
      progress.bytesRead >= progress.totalBytes;
    if (!complete && !readingComplete && now - lastWorldProgressAt < EMIT_INTERVAL_MS) return;
    lastWorldProgressAt = now;
    postProgress({
      type: "progress",
      requestId: request.requestId,
      deltaBlocks: [],
      receivedBlocks: 0,
      totalBlocks: null,
      stage: progress.stage,
      bytesRead: progress.bytesRead,
      totalBytes: progress.totalBytes,
      processedBlocks: progress.processedBlocks,
      processedTotalBlocks: progress.totalBlocks,
    });
  };

  try {
    const finishWorld = (
      build: RenderableVoxelBuild,
      warnings: string[],
      source: ParseSource,
      localWorld?: LocalVoxelWorldOwnership,
    ) => {
      if (isCancelled(request.requestId)) return;
      const manifest = build.world!.manifest;
      postMessage({
        type: "complete",
        requestId: request.requestId,
        voxelBuild: build,
        warnings,
        receivedBlocks: manifest.exactBlockCount,
        totalBlocks: manifest.exactBlockCount,
        source,
        resolved: { gridSize: manifest.gridSize as GridSize, palette: manifest.palette },
        ...(localWorld ? { localWorld } : {}),
      } satisfies CompleteMessage);
    };
    if (request.gridSize > 512) {
      try {
        const world = await createLocalVoxelWorld(request.file ?? new Blob([request.rawText]), {
          gridSize: request.gridSize,
          palette: request.palette,
          signal: abortController.signal,
          onProgress: postWorldProgress,
        });
        if (isCancelled(request.requestId)) {
          throw new Error(CANCELLED_ERROR);
        }

        finishWorld(world.build, world.warnings, "build-json", {
          worldId: world.worldId,
          partKeys: world.partKeys,
        });
        return;
      } catch (error) {
        if (request.file || !(error instanceof LocalVoxelWorldSourceError)) throw error;
        postProgress({
          type: "progress",
          requestId: request.requestId,
          deltaBlocks: [],
          receivedBlocks: 0,
          totalBlocks: null,
        });
      }
    }
    if (request.file) {
      postProgress({
        type: "progress",
        requestId: request.requestId,
        deltaBlocks: [],
        receivedBlocks: 0,
        totalBlocks: null,
        stage: "reading",
        bytesRead: 0,
        totalBytes: request.file.size,
      });
      raw = trimOuterWhitespace(await request.file.text());
      if (isCancelled(request.requestId)) {
        throw new Error(CANCELLED_ERROR);
      }
      postProgress({
        type: "progress",
        requestId: request.requestId,
        deltaBlocks: [],
        receivedBlocks: 0,
        totalBlocks: null,
        stage: "reading",
        bytesRead: request.file.size,
        totalBytes: request.file.size,
      });
      if (!raw) {
        throw new Error("Paste a JSON object first.");
      }
    }
    let baseBuild: VoxelBuild | null = null;
    let totalBlocks: number | null = null;
    let source: ParseSource = "build-json";
    let resolvedGridSize: GridSize = request.gridSize;
    let resolvedPalette: Palette = request.palette;
    const sourceWarnings: string[] = [];

    const parseRequest = raw === request.rawText ? request : { ...request, rawText: raw };
    const streamed = request.gridSize > 512 ? null : streamBlocksFromText(parseRequest, postProgress);
    // If we didn't manage to extract any blocks, fall back to full JSON extraction so we can
    // handle builds that rely on `boxes`/`lines` primitives (or non-standard block encodings).
    if (streamed && streamed.blocks.length > 0) {
      totalBlocks = streamed.totalBlocks;
      baseBuild = {
        version: "1.0",
        blocks: streamed.blocks,
      };
    } else {
      const topLevelObjects = parseTopLevelJsonObjects(raw, 4);
      const toolCall =
        topLevelObjects.map(parseToolCallInput).find((candidate): candidate is ToolCallInput => candidate != null) ??
        null;

      const extracted: unknown | null = toolCall
        ? null
        : topLevelObjects.length === 1
          ? topLevelObjects[0]
          : extractBestVoxelBuildJson(raw);

      if (toolCall) {
        const executed = await executeVoxelExecToolCall(toolCall, abortController.signal);
        if (isCancelled(request.requestId)) {
          throw new Error(CANCELLED_ERROR);
        }

        source = "tool-call";
        resolvedGridSize = toolCall.gridSize;
        resolvedPalette = toolCall.palette;
        sourceWarnings.push(...executed.warnings);

        const serverWorld = readServerWorld(executed.build, executed.generationId);
        if (serverWorld) {
          finishWorld(serverWorld, sourceWarnings, source);
          return;
        }
        if (executed.generationId) throw new Error("Import returned no prepared world");

        if (resolvedGridSize > 512) {
          const world = await createLocalVoxelWorld(executed.build, {
            gridSize: resolvedGridSize,
            palette: resolvedPalette,
            signal: abortController.signal,
            onProgress: postWorldProgress,
          });
          if (isCancelled(request.requestId)) {
            throw new Error(CANCELLED_ERROR);
          }

          const complete: CompleteMessage = {
            type: "complete",
            requestId: request.requestId,
            voxelBuild: world.build,
            warnings: sourceWarnings.concat(world.warnings),
            receivedBlocks: world.blockCount,
            totalBlocks: world.blockCount,
            source,
            resolved: {
              gridSize: resolvedGridSize,
              palette: resolvedPalette,
            },
            localWorld: {
              worldId: world.worldId,
              partKeys: world.partKeys,
            },
          };
          postMessage(complete satisfies WorkerResponse);
          return;
        }

        const validatedTool = validateVoxelBuild(executed.build, {
          gridSize: resolvedGridSize,
          palette: getPalette(resolvedPalette),
          maxBlocks: request.maxBlocksByGrid[resolvedGridSize],
        });

        if (!validatedTool.ok) {
          throw new Error(validatedTool.error);
        }

        const complete: CompleteMessage = {
          type: "complete",
          requestId: request.requestId,
          voxelBuild: validatedTool.value.build,
          warnings: sourceWarnings.concat(validatedTool.value.warnings),
          receivedBlocks: validatedTool.value.build.blocks.length,
          totalBlocks: validatedTool.value.build.blocks.length,
          source,
          resolved: {
            gridSize: resolvedGridSize,
            palette: resolvedPalette,
          },
        };
        postMessage(complete satisfies WorkerResponse);
        return;
      }

      if (!extracted) {
        throw new Error("Could not find a valid JSON object. Paste the raw JSON if possible.");
      }

      if (resolvedGridSize > 512) {
        const world = await createLocalVoxelWorld(extracted, {
          gridSize: resolvedGridSize,
          palette: resolvedPalette,
          signal: abortController.signal,
          onProgress: postWorldProgress,
        });
        if (isCancelled(request.requestId)) {
          throw new Error(CANCELLED_ERROR);
        }

        const complete: CompleteMessage = {
          type: "complete",
          requestId: request.requestId,
          voxelBuild: world.build,
          warnings: world.warnings,
          receivedBlocks: world.blockCount,
          totalBlocks: world.blockCount,
          source,
          resolved: {
            gridSize: resolvedGridSize,
            palette: resolvedPalette,
          },
          localWorld: {
            worldId: world.worldId,
            partKeys: world.partKeys,
          },
        };
        postMessage(complete satisfies WorkerResponse);
        return;
      }

      const validatedDirect = validateVoxelBuild(extracted, {
        gridSize: resolvedGridSize,
        palette: getPalette(resolvedPalette),
        maxBlocks: request.maxBlocksByGrid[resolvedGridSize],
      });

      if (!validatedDirect.ok) {
        throw new Error(validatedDirect.error);
      }

      if (isCancelled(request.requestId)) {
        throw new Error(CANCELLED_ERROR);
      }

      const complete: CompleteMessage = {
        type: "complete",
        requestId: request.requestId,
        voxelBuild: validatedDirect.value.build,
        warnings: validatedDirect.value.warnings,
        receivedBlocks: validatedDirect.value.build.blocks.length,
        totalBlocks: validatedDirect.value.build.blocks.length,
        source,
        resolved: {
          gridSize: resolvedGridSize,
          palette: resolvedPalette,
        },
      };
      postMessage(complete satisfies WorkerResponse);
      return;
    }

    const validated = validateVoxelBuild(baseBuild, {
      gridSize: resolvedGridSize,
      palette: getPalette(resolvedPalette),
      maxBlocks: request.maxBlocksByGrid[resolvedGridSize],
    });

    if (!validated.ok) {
      throw new Error(validated.error);
    }

    if (isCancelled(request.requestId)) {
      throw new Error(CANCELLED_ERROR);
    }

    const complete: CompleteMessage = {
      type: "complete",
      requestId: request.requestId,
      voxelBuild: validated.value.build,
      warnings: validated.value.warnings,
      receivedBlocks: validated.value.build.blocks.length,
      totalBlocks: totalBlocks ?? validated.value.build.blocks.length,
      source,
      resolved: {
        gridSize: resolvedGridSize,
        palette: resolvedPalette,
      },
    };
    postMessage(complete satisfies WorkerResponse);
  } catch (err) {
    if (err instanceof Error && err.message === CANCELLED_ERROR) {
      return;
    }

    const message: ErrorMessage = {
      type: "error",
      requestId: request.requestId,
      message: err instanceof Error ? err.message : "Failed to parse build",
    };
    postMessage(message satisfies WorkerResponse);
  } finally {
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || shuttingDown) return;

  if (message.type === "cancel") {
    if (message.shutdown || message.requestId == null || message.requestId === activeRequestId) {
      activeRequestId = -1;
      activeAbortController?.abort();
      activeAbortController = null;
    }
    if (message.shutdown) {
      shuttingDown = true;
      await Promise.allSettled(pendingParses);
      self.close();
    }
    return;
  }

  const pending = runParse(message);
  pendingParses.add(pending);
  try {
    await pending;
  } finally {
    pendingParses.delete(pending);
  }
};

export {};
