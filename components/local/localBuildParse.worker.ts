import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { getPalette } from "@/lib/blocks/palettes";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";

type GridSize = 64 | 256 | 512;
type Palette = "simple" | "advanced";

type ParseRequest = {
  type: "parse";
  requestId: number;
  rawText: string;
  gridSize: GridSize;
  palette: Palette;
  maxBlocks: number;
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
  const idx = text.indexOf(`"${field}"`);
  if (idx < 0) return -1;
  return text.indexOf("[", idx);
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

function streamBlocksFromText(
  request: ParseRequest,
  postProgress: (msg: ProgressMessage) => void,
): { blocks: VoxelBlock[]; totalBlocks: number | null } | null {
  const text = request.rawText;
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

  const raw = request.rawText.trim();
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

    const streamed = streamBlocksFromText(request, postProgress);
    if (streamed) {
      totalBlocks = streamed.totalBlocks;
      baseBuild = {
        version: "1.0",
        blocks: streamed.blocks,
      };
    } else {
      const extracted = extractBestVoxelBuildJson(raw);
      if (!extracted) {
        throw new Error("Could not find a valid JSON object. Paste the raw JSON if possible.");
      }

      const validatedDirect = validateVoxelBuild(extracted, {
        gridSize: request.gridSize,
        palette: getPalette(request.palette),
        maxBlocks: request.maxBlocks,
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
      };
      postMessage(complete satisfies WorkerResponse);
      return;
    }

    const validated = validateVoxelBuild(baseBuild, {
      gridSize: request.gridSize,
      palette: getPalette(request.palette),
      maxBlocks: request.maxBlocks,
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
