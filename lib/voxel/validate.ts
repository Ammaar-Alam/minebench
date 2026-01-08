import { z } from "zod";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import type { VoxelBuild } from "@/lib/voxel/types";

const blockSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  type: z.string().min(1),
});

const pointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

const boxSchema = z.object({
  x1: z.number().int(),
  y1: z.number().int(),
  z1: z.number().int(),
  x2: z.number().int(),
  y2: z.number().int(),
  z2: z.number().int(),
  type: z.string().min(1),
});

const lineSchema = z.object({
  from: pointSchema,
  to: pointSchema,
  type: z.string().min(1),
});

const buildSchema = z.object({
  version: z.literal("1.0"),
  blocks: z.array(blockSchema),
  boxes: z.array(boxSchema).optional(),
  lines: z.array(lineSchema).optional(),
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

function clampInt(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function expandBuildPrimitives(
  data: z.infer<typeof buildSchema>,
  opts: ValidateVoxelOptions
): { ok: true; blocks: { x: number; y: number; z: number; type: string }[] } | { ok: false; error: string } {
  const expanded: { x: number; y: number; z: number; type: string }[] = [];

  // Safety limit to prevent pathological expansions (e.g., a full solid 128^3 cube).
  const expansionLimit = Math.max(opts.maxBlocks * 2, 20000);
  let count = 0;
  const push = (b: { x: number; y: number; z: number; type: string }) => {
    expanded.push(b);
    count += 1;
    if (count > expansionLimit) throw new Error(`Too many blocks after expanding primitives (${count})`);
  };

  const boxes = data.boxes ?? [];
  const lines = data.lines ?? [];

  try {
    for (const box of boxes) {
      const xMin = Math.min(box.x1, box.x2);
      const xMax = Math.max(box.x1, box.x2);
      const yMin = Math.min(box.y1, box.y2);
      const yMax = Math.max(box.y1, box.y2);
      const zMin = Math.min(box.z1, box.z2);
      const zMax = Math.max(box.z1, box.z2);

      // Expand inclusive ranges. Coordinates are validated/dropped later, so we don’t clamp here.
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          for (let z2 = zMin; z2 <= zMax; z2++) {
            push({ x, y, z: z2, type: box.type });
          }
        }
      }
    }

    for (const line of lines) {
      const x1 = line.from.x;
      const y1 = line.from.y;
      const z1 = line.from.z;
      const x2 = line.to.x;
      const y2 = line.to.y;
      const z2 = line.to.z;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const dz = z2 - z1;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));

      if (steps <= 0) {
        push({ x: x1, y: y1, z: z1, type: line.type });
        continue;
      }

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // DDA line; duplicates are fine (deduped later)
        const x = Math.round(x1 + dx * t);
        const y = Math.round(y1 + dy * t);
        const z = Math.round(z1 + dz * t);
        push({ x, y, z, type: line.type });
      }
    }

    // Explicit blocks last so they can override primitives at the same coordinate.
    for (const b of data.blocks) push(b);

    return { ok: true, blocks: expanded };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to expand primitives" };
  }
}

export function validateVoxelBuild(
  input: unknown,
  opts: ValidateVoxelOptions
): { ok: true; value: ValidatedVoxelBuild } | { ok: false; error: string } {
  const parsed = buildSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const expanded = expandBuildPrimitives(parsed.data, opts);
  if (!expanded.ok) return { ok: false, error: expanded.error };

  const allowed = new Set(opts.palette.map((b) => b.id));
  const warnings: string[] = [];
  let droppedNegative = 0;
  let droppedOutOfBounds = 0;
  const droppedUnknownTypeCounts = new Map<string, number>();

  const keyToBlock = new Map<number, { x: number; y: number; z: number; type: string }>();
  const encode = (x: number, y: number, z: number) => x | (y << 7) | (z << 14);

  for (const b of expanded.blocks) {
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

    // ensure we store ints even if something slipped through
    const x = clampInt(Math.trunc(b.x), 0, opts.gridSize - 1);
    const y = clampInt(Math.trunc(b.y), 0, opts.gridSize - 1);
    const z3 = clampInt(Math.trunc(b.z), 0, opts.gridSize - 1);

    keyToBlock.set(encode(x, y, z3), {
      x,
      y,
      z: z3,
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
