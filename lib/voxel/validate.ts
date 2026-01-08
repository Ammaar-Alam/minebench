import { z } from "zod";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import type { VoxelBuild } from "@/lib/voxel/types";

const blockSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  type: z.string().min(1),
});

const buildSchema = z.object({
  version: z.literal("1.0"),
  blocks: z.array(blockSchema),
});

export type ValidateVoxelOptions = {
  gridSize: number;
  palette: BlockDefinition[];
  maxBlocks: number;
};

export type ValidatedVoxelBuild = {
  build: VoxelBuild;
  warnings: string[];
};

export function validateVoxelBuild(
  input: unknown,
  opts: ValidateVoxelOptions
): { ok: true; value: ValidatedVoxelBuild } | { ok: false; error: string } {
  const parsed = buildSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const allowed = new Set(opts.palette.map((b) => b.id));
  const warnings: string[] = [];

  const keyToBlock = new Map<number, { x: number; y: number; z: number; type: string }>();
  const encode = (x: number, y: number, z: number) => x | (y << 7) | (z << 14);

  for (const b of parsed.data.blocks) {
    if (b.x < 0 || b.y < 0 || b.z < 0) {
      warnings.push("Dropped blocks with negative coordinates");
      continue;
    }
    if (b.x >= opts.gridSize || b.y >= opts.gridSize || b.z >= opts.gridSize) {
      warnings.push("Dropped blocks outside the grid bounds");
      continue;
    }
    if (!allowed.has(b.type)) {
      warnings.push(`Dropped unknown block type: ${b.type}`);
      continue;
    }
    keyToBlock.set(encode(b.x, b.y, b.z), b);
  }

  const blocks = Array.from(keyToBlock.values());
  if (blocks.length > opts.maxBlocks) {
    return {
      ok: false,
      error: `Too many blocks (${blocks.length}) > maxBlocks (${opts.maxBlocks})`,
    };
  }

  return { ok: true, value: { build: { version: "1.0", blocks }, warnings } };
}

