import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vm from "node:vm";
import { z } from "zod";
import { MAX_BLOCKS_BY_GRID, type GridSize } from "@/lib/ai/limits";
import type { PaletteMode } from "@/lib/ai/types";
import type { VoxelBuild } from "@/lib/voxel/types";

export const VOXEL_EXEC_TOOL_NAME = "voxel.exec" as const;

export const voxelExecToolCallSchema = z.object({
  tool: z.literal(VOXEL_EXEC_TOOL_NAME),
  input: z.object({
    code: z.string().min(1),
    gridSize: z.union([z.literal(64), z.literal(256), z.literal(512)]),
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
          gridSize: { type: "integer", enum: [64, 256, 512] },
          palette: { type: "string", enum: ["simple", "advanced"] },
          seed: { type: "integer" },
        },
        required: ["code", "gridSize", "palette"],
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
  filePath: string;
  // Expanded block count after validation/dedup is computed elsewhere; this is raw spec counts.
  blockCount: number;
  boxCount: number;
  lineCount: number;
  seed?: number;
  build: VoxelBuild;
};

function pickOutputDir(preferred: string | undefined): string {
  const candidates: string[] = [];
  if (preferred) candidates.push(preferred);
  if (process.env.MINEBENCH_TOOL_OUTPUT_DIR) candidates.push(process.env.MINEBENCH_TOOL_OUTPUT_DIR);
  candidates.push(path.join(process.cwd(), "uploads", "tool-runs"));
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

  // Should be unreachable, but keep a safe fallback.
  return path.join(os.tmpdir(), "minebench-tool-runs");
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
    Math.min(60_000, Math.floor(Number(process.env.MINEBENCH_TOOL_TIMEOUT_MS ?? 12_000))),
  );
  const maxBoxes = Math.max(10_000, Math.floor(Number(process.env.MINEBENCH_TOOL_MAX_BOXES ?? 200_000)));
  const maxLines = Math.max(10_000, Math.floor(Number(process.env.MINEBENCH_TOOL_MAX_LINES ?? 200_000)));
  const gridMaxBlocks = MAX_BLOCKS_BY_GRID[params.gridSize];
  const maxBlocksEnv = Math.max(50_000, Math.floor(Number(process.env.MINEBENCH_TOOL_MAX_BLOCKS ?? gridMaxBlocks)));
  // Allow some overhead for duplicates/out-of-bounds, but prevent runaway memory usage.
  const maxBlocks = Math.min(maxBlocksEnv, gridMaxBlocks * 2);

  const boxes: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; type: string }[] =
    [];
  const lines: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; type: string }[] =
    [];
  const blocks: { x: number; y: number; z: number; type: string }[] = [];

  const block = (x: unknown, y: unknown, z: unknown, type: unknown) => {
    if (blocks.length >= maxBlocks) throw new Error(`Too many blocks (${blocks.length})`);
    blocks.push({ x: toInt(x), y: toInt(y), z: toInt(z), type: toType(type) });
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
    if (boxes.length >= maxBoxes) throw new Error(`Too many boxes (${boxes.length})`);
    boxes.push({
      x1: toInt(x1),
      y1: toInt(y1),
      z1: toInt(z1),
      x2: toInt(x2),
      y2: toInt(y2),
      z2: toInt(z2),
      type: toType(type),
    });
  };
  const line = (
    x1: unknown,
    y1: unknown,
    z1: unknown,
    x2: unknown,
    y2: unknown,
    z2: unknown,
    type: unknown,
  ) => {
    if (lines.length >= maxLines) throw new Error(`Too many lines (${lines.length})`);
    lines.push({
      from: { x: toInt(x1), y: toInt(y1), z: toInt(z1) },
      to: { x: toInt(x2), y: toInt(y2), z: toInt(z2) },
      type: toType(type),
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
  const wrapped = `"use strict";\n${params.code}\n`;
  const script = new vm.Script(wrapped, { filename: "voxel.exec.js" });

  script.runInContext(ctx, { timeout: timeoutMs });

  const build: VoxelBuild = {
    version: "1.0",
    boxes,
    lines,
    blocks,
  };

  const outDir = pickOutputDir(params.outputDir);
  const runId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  const filePath = path.join(outDir, `voxel-exec-${Date.now()}-${runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(build));

  return {
    filePath,
    blockCount: blocks.length,
    boxCount: boxes.length,
    lineCount: lines.length,
    seed: params.seed,
    build,
  };
}
