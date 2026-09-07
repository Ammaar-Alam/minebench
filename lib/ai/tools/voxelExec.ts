import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vm from "node:vm";
import { z } from "zod";
import { type GridSize, GRID_SIZES, isGridSize } from "@/lib/ai/limits";
import type { PaletteMode } from "@/lib/ai/types";
import type { VoxelBuild } from "@/lib/voxel/types";
import { voxelBuildSourceJsonChunks } from "@/lib/voxel/canonicalArtifact";
import {
  appendCoalescedVoxelBox,
  appendPackedVoxelBlocks,
  createPackedVoxelBlocks,
} from "@/lib/voxel/packedBlocks";

export const VOXEL_EXEC_TOOL_NAME = "voxel.exec" as const;
export const DEFAULT_VOXEL_EXEC_TIMEOUT_MS = 30_000;
export const LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS = 15 * 60_000;

export const voxelExecToolCallSchema = z.object({
  tool: z.literal(VOXEL_EXEC_TOOL_NAME),
  input: z.object({
    code: z.string().min(1),
    gridSize: z.custom<GridSize>(isGridSize),
    palette: z.union([z.literal("simple"), z.literal("advanced")]),
    seed: z.number().int().optional(),
  }),
});

export type VoxelExecToolCall = z.infer<typeof voxelExecToolCallSchema>;

export function voxelExecToolCallJsonSchema() {
  return {
    type: "object",
    properties: {
      tool: { type: "string", enum: [VOXEL_EXEC_TOOL_NAME] },
      input: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          gridSize: { type: "integer", enum: GRID_SIZES },
          palette: { type: "string", enum: ["simple", "advanced"] },
          seed: { type: "integer" },
        },
        // OpenAI structured outputs (strict) requires required[] to include every key in properties.
        required: ["code", "gridSize", "palette", "seed"],
        additionalProperties: false,
      },
    },
    required: ["tool", "input"],
    additionalProperties: false,
  } as const;
}

export type VoxelExecRunParams = {
  code: string;
  gridSize: GridSize;
  palette: PaletteMode;
  seed?: number;
  // Optional: for deterministic file layout in scripts.
  outputDir?: string;
};

export type VoxelExecRunResult = {
  filePath: string | null;
  // Expanded block count after validation/dedup is computed elsewhere; this is raw spec counts.
  blockCount: number;
  boxCount: number;
  lineCount: number;
  seed?: number;
  build: VoxelBuild;
};

function pickOutputDir(preferred: string | undefined): string | null {
  const candidates: string[] = [];
  if (preferred) candidates.push(preferred);
  if (process.env.MINEBENCH_TOOL_OUTPUT_DIR) candidates.push(process.env.MINEBENCH_TOOL_OUTPUT_DIR);

  if (candidates.length === 0) return null;
  candidates.push(path.join(os.tmpdir(), "minebench-tool-runs"));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // keep trying
    }
  }

  return null;
}

function toInt(n: unknown): number {
  const v = typeof n === "bigint" ? Number(n) : Number(n);
  if (!Number.isFinite(v)) throw new Error("Non-finite numeric argument");
  return Math.trunc(v);
}

function toType(t: unknown): string {
  if (typeof t !== "string") throw new Error("Block type must be a string");
  const s = t.trim();
  if (!s) throw new Error("Block type must be non-empty");
  return s;
}

function readOptionalLimitEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function toPoint(
  value: unknown,
  label: string,
): { x: number; y: number; z: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} point argument`);
  }

  const point = value as Record<string, unknown>;
  return {
    x: toInt(point.x),
    y: toInt(point.y),
    z: toInt(point.z),
  };
}

function makeRng(seed: number | undefined): () => number {
  if (typeof seed !== "number" || !Number.isFinite(seed)) return Math.random;
  // xorshift32
  let x = (seed | 0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    // uint32 -> [0, 1)
    return (x >>> 0) / 0x1_0000_0000;
  };
}

export function runVoxelExec(params: VoxelExecRunParams): VoxelExecRunResult {
  const timeoutMs = Math.max(
    250,
    Math.min(
      LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS,
      readOptionalLimitEnv("MINEBENCH_TOOL_TIMEOUT_MS") ??
        (params.gridSize > 512 ? LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS : DEFAULT_VOXEL_EXEC_TIMEOUT_MS),
    ),
  );
  const maxBoxes = readOptionalLimitEnv("MINEBENCH_TOOL_MAX_BOXES");
  const maxLines = readOptionalLimitEnv("MINEBENCH_TOOL_MAX_LINES");
  const maxBlocks = readOptionalLimitEnv("MINEBENCH_TOOL_MAX_BLOCKS");

  const boxes: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; type: string }[] =
    [];
  const lines: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; type: string }[] =
    [];
  const blocks: { x: number; y: number; z: number; type: string }[] = [];
  const packed = params.gridSize > 512 ? createPackedVoxelBlocks(0) : undefined;
  const blockBatch: typeof blocks = [];
  let blockCount = 0;
  let boxCount = 0;
  const flushBlocks = () => {
    if (!packed || blockBatch.length === 0) return;
    appendPackedVoxelBlocks(packed, blockBatch);
    blockBatch.length = 0;
  };

  const block = (x: unknown, y: unknown, z: unknown, type: unknown) => {
    if (maxBlocks !== null && blockCount >= maxBlocks) {
      throw new Error(`Too many blocks (${blockCount})`);
    }
    const value = { x: toInt(x), y: toInt(y), z: toInt(z), type: toType(type) };
    blockCount += 1;
    if (packed && value.x >= -32_768 && value.x <= 32_767 && value.y >= -32_768 && value.y <= 32_767 && value.z >= -32_768 && value.z <= 32_767) {
      blockBatch.push(value);
      if (blockBatch.length === 4096) flushBlocks();
    } else blocks.push(value);
  };
  const box = (
    x1: unknown,
    y1: unknown,
    z1: unknown,
    x2: unknown,
    y2: unknown,
    z2: unknown,
    type: unknown,
  ) => {
    if (maxBoxes !== null && boxCount >= maxBoxes) {
      throw new Error(`Too many boxes (${boxCount})`);
    }
    const value = {
      x1: toInt(x1),
      y1: toInt(y1),
      z1: toInt(z1),
      x2: toInt(x2),
      y2: toInt(y2),
      z2: toInt(z2),
      type: toType(type),
    };
    boxCount += 1;
    if (packed) appendCoalescedVoxelBox(boxes, value);
    else boxes.push(value);
  };
  const line = (...args: unknown[]) => {
    if (maxLines !== null && lines.length >= maxLines) {
      throw new Error(`Too many lines (${lines.length})`);
    }

    let from: { x: number; y: number; z: number };
    let to: { x: number; y: number; z: number };
    let type: string;

    if (args.length === 3) {
      from = toPoint(args[0], "line from");
      to = toPoint(args[1], "line to");
      type = toType(args[2]);
    } else if (args.length === 7) {
      from = { x: toInt(args[0]), y: toInt(args[1]), z: toInt(args[2]) };
      to = { x: toInt(args[3]), y: toInt(args[4]), z: toInt(args[5]) };
      type = toType(args[6]);
    } else {
      throw new Error(
        "line() expects line(x1, y1, z1, x2, y2, z2, type) or line({x,y,z}, {x,y,z}, type)",
      );
    }

    lines.push({
      from,
      to,
      type,
    });
  };

  const rng = makeRng(params.seed);

  const sandbox: Record<string, unknown> = Object.create(null);
  sandbox.block = block;
  sandbox.box = box;
  sandbox.line = line;
  sandbox.rng = rng;
  sandbox.Math = Math;
  sandbox.GRID_SIZE = params.gridSize;
  sandbox.PALETTE = params.palette;

  const ctx = vm.createContext(sandbox, {
    name: "minebench-voxel-exec",
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrap code to reduce accidental top-level await / module syntax issues.
  // lexical helper bindings avoid repeated context-global lookups in large loops
  const wrapped = params.gridSize > 512
    ? `"use strict";\n((block, box, line, rng, Math, GRID_SIZE, PALETTE) => (() => {\n${params.code}\n})())(block, box, line, rng, Math, GRID_SIZE, PALETTE);`
    : `"use strict";\n${params.code}\n`;
  const script = new vm.Script(wrapped, { filename: "voxel.exec.js" });

  script.runInContext(ctx, { timeout: timeoutMs });
  flushBlocks();

  const build: VoxelBuild = {
    version: "1.0",
    boxes,
    lines,
    blocks,
    ...(packed ? { packed } : {}),
  };

  const outDir = pickOutputDir(params.outputDir);
  let filePath: string | null = null;
  if (outDir) {
    const runId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");
    filePath = path.join(outDir, `voxel-exec-${Date.now()}-${runId}.json`);
    if (build.packed) {
      const fd = fs.openSync(filePath, "wx");
      try {
        for (const bytes of voxelBuildSourceJsonChunks(build)) fs.writeSync(fd, bytes);
      } finally {
        fs.closeSync(fd);
      }
    } else fs.writeFileSync(filePath, JSON.stringify(build));
  }

  return {
    filePath,
    blockCount,
    boxCount,
    lineCount: lines.length,
    seed: params.seed,
    build,
  };
}
