import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getPalette } from "@/lib/blocks/palettes";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";

type GridSize = 64 | 256 | 512;
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
  gridSize: GridSize;
  palette: Palette;
  maxBlocksByGrid: Record<GridSize, number>;
};

type CancelRequest = {
  type: "cancel";
  requestId?: number;
};

type WorkerRequest = ParseRequest | CancelRequest;

type ProgressMessage = {
  type: "progress";
  requestId: number;
  deltaBlocks: VoxelBlock[];
  receivedBlocks: number;
  totalBlocks: number | null;
};

type CompleteMessage = {
  type: "complete";
  requestId: number;
  voxelBuild: VoxelBuild;
  warnings: string[];
  receivedBlocks: number;
  totalBlocks: number | null;
  source: ParseSource;
  resolved: ResolvedSettings;
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
  if (input.gridSize !== 64 && input.gridSize !== 256 && input.gridSize !== 512) return null;
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

async function executeVoxelExecToolCall(input: ToolCallInput): Promise<{ build: unknown; warnings: string[] }> {
  const response = await fetch("/api/local/voxel-exec", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const bodyText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as unknown) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const serverError =
      parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        ? ((parsed as { error: string }).error ?? "")
        : "";

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
  activeRequestId = request.requestId;

  const raw = trimOuterWhitespace(request.rawText);
  if (!raw) {
    const message: ErrorMessage = {
      type: "error",
      requestId: request.requestId,
      message: "Paste a JSON object first.",
    };
    postMessage(message satisfies WorkerResponse);
    return;
  }

  const postProgress = (msg: ProgressMessage) => {
    if (isCancelled(request.requestId)) return;
    postMessage(msg satisfies WorkerResponse);
  };

  try {
    let baseBuild: VoxelBuild | null = null;
    let totalBlocks: number | null = null;
    let source: ParseSource = "build-json";
    let resolvedGridSize: GridSize = request.gridSize;
    let resolvedPalette: Palette = request.palette;
    const sourceWarnings: string[] = [];

    const streamed = streamBlocksFromText(request, postProgress);
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
        const executed = await executeVoxelExecToolCall(toolCall);
        if (isCancelled(request.requestId)) {
          throw new Error(CANCELLED_ERROR);
        }

        source = "tool-call";
        resolvedGridSize = toolCall.gridSize;
        resolvedPalette = toolCall.palette;
        sourceWarnings.push(...executed.warnings);

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
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message) return;

  if (message.type === "cancel") {
    if (message.requestId == null || message.requestId === activeRequestId) {
      activeRequestId = -1;
    }
    return;
  }

  void runParse(message);
};

export {};
