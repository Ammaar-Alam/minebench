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

export function parseVoxelBuildSpec(
  input: unknown,
): { ok: true; value: VoxelBuild } | { ok: false; error: string } {
  const parsed = buildSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  return {
    ok: true,
    value: {
      version: "1.0",
      boxes: parsed.data.boxes ?? [],
      lines: parsed.data.lines ?? [],
      blocks: parsed.data.blocks,
    },
  };
}

const TYPE_ALIASES: Record<string, string> = {
  // Common LLM drift / minecraft namespace prefixes
  oak_plank: "oak_planks",
  wood_planks: "oak_planks",
  planks: "oak_planks",
  oak_wood: "oak_log",
  wood_log: "oak_log",
  log: "oak_log",
  grass: "grass_block",
  glowstone_block: "glowstone",
  iron: "iron_block",
  gold: "gold_block",
  stonebrick: "stone_bricks",
  stone_brick: "stone_bricks",
  snow_block: "snow",
  ice_block: "ice",
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

export function validateVoxelBuild(
  input: unknown,
  opts: ValidateVoxelOptions,
): { ok: true; value: ValidatedVoxelBuild } | { ok: false; error: string } {
  const parsed = buildSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const allowed = new Set(opts.palette.map((b) => b.id));
  const warnings: string[] = [];
  let droppedNegative = 0;
  let droppedOutOfBounds = 0;
  const droppedUnknownTypeCounts = new Map<string, number>();

  const keyToBlock = new Map<number, { x: number; y: number; z: number; type: string }>();
  // 10 bits per coordinate supports up to 1024³ grids (covers 512³).
  const encode = (x: number, y: number, z: number) => x | (y << 10) | (z << 20);

  // Hard cap to prevent pathological expansions from primitives. We enforce this BEFORE building any huge intermediate arrays.
  const expansionBudget = Math.max(opts.maxBlocks * 2, 20000);
  let expandedCount = 0;
  const charge = (n: number) => {
    expandedCount += n;
    if (expandedCount > expansionBudget) {
      throw new Error(`Too many blocks after expanding primitives (${expandedCount})`);
    }
  };

  const bumpUnknownType = (rawType: string, count: number) => {
    const key = rawType.trim() ? rawType.trim().toLowerCase() : "(empty)";
    droppedUnknownTypeCounts.set(key, (droppedUnknownTypeCounts.get(key) ?? 0) + count);
  };

  const put = (xRaw: number, yRaw: number, zRaw: number, type: string) => {
    if (xRaw < 0 || yRaw < 0 || zRaw < 0) {
      droppedNegative += 1;
      return;
    }
    if (xRaw >= opts.gridSize || yRaw >= opts.gridSize || zRaw >= opts.gridSize) {
      droppedOutOfBounds += 1;
      return;
    }

    const x = clampInt(Math.trunc(xRaw), 0, opts.gridSize - 1);
    const y = clampInt(Math.trunc(yRaw), 0, opts.gridSize - 1);
    const z = clampInt(Math.trunc(zRaw), 0, opts.gridSize - 1);

    keyToBlock.set(encode(x, y, z), { x, y, z, type });
  };

  try {
    const boxes = parsed.data.boxes ?? [];
    const lines = parsed.data.lines ?? [];

    for (const box of boxes) {
      const xMin = Math.min(box.x1, box.x2);
      const xMax = Math.max(box.x1, box.x2);
      const yMin = Math.min(box.y1, box.y2);
      const yMax = Math.max(box.y1, box.y2);
      const zMin = Math.min(box.z1, box.z2);
      const zMax = Math.max(box.z1, box.z2);

      const vol = (xMax - xMin + 1) * (yMax - yMin + 1) * (zMax - zMin + 1);
      if (!Number.isFinite(vol) || vol <= 0) continue;
      charge(vol);

      const normalizedType = normalizeBlockType(box.type, allowed);
      if (!normalizedType) {
        bumpUnknownType(box.type, vol);
        continue;
      }

      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          for (let z2 = zMin; z2 <= zMax; z2++) {
            put(x, y, z2, normalizedType);
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
      const len = Math.max(1, steps + 1);
      charge(len);

      const normalizedType = normalizeBlockType(line.type, allowed);
      if (!normalizedType) {
        bumpUnknownType(line.type, len);
        continue;
      }

      if (steps <= 0) {
        put(x1, y1, z1, normalizedType);
        continue;
      }

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // DDA line; duplicates are fine (deduped by key map)
        const x = Math.round(x1 + dx * t);
        const y = Math.round(y1 + dy * t);
        const z = Math.round(z1 + dz * t);
        put(x, y, z, normalizedType);
      }
    }

    // Explicit blocks last so they can override primitives at the same coordinate.
    const blocks = parsed.data.blocks;
    charge(blocks.length);
    for (const b of blocks) {
      const normalizedType = normalizeBlockType(b.type, allowed);
      if (!normalizedType) {
        bumpUnknownType(b.type, 1);
        continue;
      }
      put(b.x, b.y, b.z, normalizedType);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to expand primitives" };
  }

  if (droppedNegative > 0)
    warnings.push(`Dropped ${droppedNegative} blocks with negative coordinates`);
  if (droppedOutOfBounds > 0)
    warnings.push(`Dropped ${droppedOutOfBounds} blocks outside the grid bounds`);

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
