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

const TYPE_ALIASES: Record<string, string> = {
  // Common LLM drift / minecraft namespace prefixes
  "oak_plank": "oak_planks",
  "wood_planks": "oak_planks",
  "planks": "oak_planks",
  "oak_wood": "oak_log",
  "wood_log": "oak_log",
  "log": "oak_log",
  "grass": "grass_block",
  "glowstone_block": "glowstone",
  "iron": "iron_block",
  "gold": "gold_block",
  "stonebrick": "stone_bricks",
  "stone_brick": "stone_bricks",
  "snow_block": "snow",
  "ice_block": "ice",
};

function normalizeBlockType(rawType: string, allowed: Set<string>): string | null {
  const trimmed = rawType.trim();
  if (!trimmed) return null;

  let t = trimmed.toLowerCase();
  if (t.startsWith("minecraft:")) t = t.slice("minecraft:".length);
  t = t.replace(/-/g, "_");

  if (allowed.has(t)) return t;

  const aliased = TYPE_ALIASES[t];
  if (aliased && allowed.has(aliased)) return aliased;

  return null;
}

export function validateVoxelBuild(
  input: unknown,
  opts: ValidateVoxelOptions
): { ok: true; value: ValidatedVoxelBuild } | { ok: false; error: string } {
  const parsed = buildSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const allowed = new Set(opts.palette.map((b) => b.id));
  const warnings: string[] = [];
  let droppedNegative = 0;
  let droppedOutOfBounds = 0;
  const droppedUnknownTypeCounts = new Map<string, number>();

  const keyToBlock = new Map<number, { x: number; y: number; z: number; type: string }>();
  const encode = (x: number, y: number, z: number) => x | (y << 7) | (z << 14);

  for (const b of parsed.data.blocks) {
    if (b.x < 0 || b.y < 0 || b.z < 0) {
      droppedNegative += 1;
      continue;
    }
    if (b.x >= opts.gridSize || b.y >= opts.gridSize || b.z >= opts.gridSize) {
      droppedOutOfBounds += 1;
      continue;
    }

    const normalizedType = normalizeBlockType(b.type, allowed);
    if (!normalizedType) {
      const key = b.type.trim() ? b.type.trim().toLowerCase() : "(empty)";
      droppedUnknownTypeCounts.set(key, (droppedUnknownTypeCounts.get(key) ?? 0) + 1);
      continue;
    }

    keyToBlock.set(encode(b.x, b.y, b.z), {
      x: b.x,
      y: b.y,
      z: b.z,
      type: normalizedType,
    });
  }

  if (droppedNegative > 0) warnings.push(`Dropped ${droppedNegative} blocks with negative coordinates`);
  if (droppedOutOfBounds > 0) warnings.push(`Dropped ${droppedOutOfBounds} blocks outside the grid bounds`);

  if (droppedUnknownTypeCounts.size > 0) {
    const top = Array.from(droppedUnknownTypeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [t, count] of top) {
      warnings.push(`Dropped unknown block type: ${t} (${count})`);
    }
    const remaining = droppedUnknownTypeCounts.size - top.length;
    if (remaining > 0) warnings.push(`Dropped ${remaining} additional unknown block types`);
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
