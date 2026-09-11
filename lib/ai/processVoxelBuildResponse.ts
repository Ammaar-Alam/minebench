import { getPalette } from "@/lib/blocks/palettes";
import { extractBestVoxelBuildJson, extractFirstJsonObject } from "@/lib/ai/jsonExtract";
import { MAX_BLOCKS_BY_GRID, MIN_BLOCKS_BY_GRID, type GridSize } from "@/lib/ai/limits";
import { runVoxelExec, voxelExecToolCallSchema } from "@/lib/ai/tools/voxelExec";
import {
  parseVoxelBuildSpec,
  validateOwnedVoxelBuild,
  validateVoxelBuild,
  validateVoxelBuildSpec,
} from "@/lib/voxel/validate";
import {
  voxelBuildBlockAt,
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { summarizeVoxelWorldRegions } from "@/lib/voxel/worldRegions";
import type { VoxelBuild } from "@/lib/voxel/types";

export type VoxelBuildResponseOptions = {
  gridSize: GridSize;
  palette: "simple" | "advanced";
  enableTools?: boolean;
  buildOutput?: "source" | "objects" | "packed";
  validationMode?: "generation" | "import";
};

export type ProcessedVoxelBuildResponse =
  | { ok: true; build: VoxelBuild; warnings: string[]; blockCount: number }
  | { ok: false; error: string };

export type ProcessVoxelBuildResponse = (
  text: string,
  opts: VoxelBuildResponseOptions,
  signal?: AbortSignal,
) => Promise<ProcessedVoxelBuildResponse>;

export function isVoxelBuildResourceError(message: string): boolean {
  return /heap_limit_exceeded|processing_capacity_exceeded/.test(message);
}

function buildBounds(build: RenderableVoxelBuild) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const count = voxelBuildBlockCount(build);
  for (let index = 0; index < count; index += 1) {
    const block = voxelBuildBlockAt(build, index)!;
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    minZ = Math.min(minZ, block.z);
    maxX = Math.max(maxX, block.x);
    maxY = Math.max(maxY, block.y);
    maxZ = Math.max(maxZ, block.z);
  }
  return { spanX: maxX - minX + 1, spanY: maxY - minY + 1, spanZ: maxZ - minZ + 1 };
}

export function processVoxelBuildResponse(
  text: string,
  opts: VoxelBuildResponseOptions,
): ProcessedVoxelBuildResponse {
  const enableTools = opts.enableTools ?? true;
  const minBlocks = MIN_BLOCKS_BY_GRID[opts.gridSize] ?? 80;
  const buildOutput = opts.buildOutput ?? "source";
  const json = enableTools ? extractFirstJsonObject(text) : extractBestVoxelBuildJson(text);
  if (!json) return { ok: false, error: "Could not find a valid JSON object in the response" };

  let buildJson: unknown = json;
  if (enableTools) {
    const parsedCall = voxelExecToolCallSchema.safeParse(json);
    if (!parsedCall.success) return { ok: false, error: parsedCall.error.message };
    const call = parsedCall.data;
    if (call.input.gridSize !== opts.gridSize) {
      return { ok: false, error: `Tool call gridSize mismatch (${call.input.gridSize} vs ${opts.gridSize})` };
    }
    if (call.input.palette !== opts.palette) {
      return { ok: false, error: `Tool call palette mismatch (${call.input.palette} vs ${opts.palette})` };
    }
    buildJson = runVoxelExec({
      code: call.input.code,
      gridSize: opts.gridSize,
      palette: opts.palette,
      seed: call.input.seed,
      packedOutput: buildOutput === "packed",
    }).build;
  }

  const validationOptions = {
    palette: getPalette(opts.palette),
    gridSize: opts.gridSize,
    // legacy expanded artifacts need bounded arrays even when the source is compact
    maxBlocks: opts.gridSize === 512 && buildOutput === "packed"
      ? MAX_BLOCKS_BY_GRID[256]
      : MAX_BLOCKS_BY_GRID[opts.gridSize],
    output: buildOutput === "packed" ? "packed" as const : "objects" as const,
  };
  const world = opts.gridSize > 512
    ? summarizeVoxelWorldRegions(buildJson, { palette: validationOptions.palette, gridSize: opts.gridSize })
    : null;
  const validated = world ?? (buildOutput === "source"
    ? enableTools
      ? validateVoxelBuildSpec(buildJson as VoxelBuild, validationOptions)
      : validateVoxelBuild(buildJson, validationOptions)
    : validateOwnedVoxelBuild(buildJson, validationOptions));
  if (!validated.ok) {
    if (opts.gridSize === 512 && buildOutput === "packed" && validated.error.startsWith("Too many blocks")) {
      return { ok: false, error: "processing_capacity_exceeded" };
    }
    return validated;
  }

  const expandedBuild = validated.value.build;
  const blockCount = world?.ok ? world.value.blockCount : voxelBuildBlockCount(expandedBuild);
  if (blockCount === 0) {
    return {
      ok: false,
      error: "No valid blocks after validation. Use ONLY in-bounds coordinates and ONLY block IDs from the available list.",
    };
  }
  if (opts.validationMode !== "import" && blockCount < minBlocks) {
    return { ok: false, error: `Build too small (${blockCount} blocks). Create at least ~${minBlocks} blocks so the result is recognizable.` };
  }

  const worldBounds = world?.ok ? world.value.bounds : null;
  const bounds = worldBounds
    ? { spanX: worldBounds.size.x, spanY: worldBounds.size.y, spanZ: worldBounds.size.z }
    : buildBounds(expandedBuild);
  const detailGridSize = Math.min(opts.gridSize, 512);
  const minFootprint = Math.max(6, Math.floor(detailGridSize * 0.15));
  const minHeight = Math.max(4, Math.floor(detailGridSize * 0.1));
  const maxFootprintSpan = Math.max(bounds.spanX, bounds.spanZ);
  if (opts.validationMode !== "import" && maxFootprintSpan < minFootprint) {
    return { ok: false, error: `Build footprint too small (span ${maxFootprintSpan}). Expand the build to span at least ~${minFootprint} blocks across x or z for more detail.` };
  }
  if (opts.validationMode !== "import" && bounds.spanY < minHeight) {
    return { ok: false, error: `Build height too small (span ${bounds.spanY}). Add more vertical structure (span at least ~${minHeight}) so it reads clearly.` };
  }

  let build = expandedBuild;
  if (!world && buildOutput === "source") {
    const spec = parseVoxelBuildSpec(buildJson);
    if (!spec.ok) return spec;
    build = spec.value;
  }
  return { ok: true, build, warnings: validated.value.warnings, blockCount };
}
