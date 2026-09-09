import type { BlockDefinition } from "@/lib/blocks/palettes";
import { MAX_VOXEL_COORDINATE } from "@/lib/voxel/coordinateKeys";
import type { VoxelBuild, VoxelPoint } from "@/lib/voxel/types";
import {
  appendPackedVoxelBoxes,
  createPackedVoxelBoxes,
  readPackedVoxelBox,
  type PackedVoxelBlocks,
  type PackedVoxelBoxRecord,
  type PackedVoxelBoxes,
} from "@/lib/voxel/packedBlocks";
import { normalizeBlockType, parseVoxelBuildSpec } from "@/lib/voxel/validate";

const DEFAULT_MIXED_LEAF_SIZE = 64;

type Bounds = {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
};

type PaintOperation = {
  bounds: Bounds;
  material: number;
  type: string;
};

type PackedPointSource = {
  packed: PackedVoxelBlocks;
  materials: Uint16Array;
  bounds: Bounds;
  count: number;
};

type PackedPointRange = {
  source: PackedPointSource;
  indices: Uint32Array;
  start: number;
  end: number;
  bounds: Bounds;
};

type PackedBoxSource = {
  packed: PackedVoxelBoxes;
  materials: Uint16Array;
  indices: Uint32Array;
  count: number;
  bounds: Bounds;
};

type PackedBoxRange = {
  source: PackedBoxSource;
  indices: Uint32Array;
  start: number;
  end: number;
  bounds: Bounds;
};

export type VoxelWorldRegionOptions = {
  gridSize: number;
  palette: BlockDefinition[];
  mixedLeafSize?: number;
};

export type UniformVoxelWorldRegion = {
  kind: "uniform";
  origin: VoxelPoint;
  size: VoxelPoint;
  type: string;
  blockCount: number;
};

export type MixedVoxelWorldRegion = {
  kind: "mixed";
  origin: VoxelPoint;
  size: VoxelPoint;
  // 0 is empty; positive values are 1-based indexes into the evaluation palette.
  materialIndexes: Uint8Array | Uint16Array;
  blockCount: number;
};

export type VoxelWorldRegion = UniformVoxelWorldRegion | MixedVoxelWorldRegion;

export type VoxelWorldRegionEvaluation =
  | { ok: true; warnings: string[]; regions: Iterable<VoxelWorldRegion> }
  | { ok: false; error: string };

export type VoxelWorldRegionBoundsEvaluation =
  | { ok: true; region: VoxelWorldRegion | null }
  | { ok: false; error: string };

export type VoxelWorldRegionEvaluator = {
  warnings: string[];
  regions: Iterable<VoxelWorldRegion>;
  evaluateBounds(origin: VoxelPoint, size: VoxelPoint): VoxelWorldRegionBoundsEvaluation;
};

function normalizeGridExtent(gridSize: number): number {
  return Number.isFinite(gridSize)
    ? Math.min(Math.max(0, Math.floor(gridSize)), MAX_VOXEL_COORDINATE + 1)
    : 0;
}

function normalizeLeafSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MIXED_LEAF_SIZE;
  return Math.min(DEFAULT_MIXED_LEAF_SIZE, Math.max(1, Math.floor(value)));
}

function sortedBounds(bounds: Bounds): Bounds {
  if (bounds.x1 <= bounds.x2 && bounds.y1 <= bounds.y2 && bounds.z1 <= bounds.z2) return bounds;
  return {
    x1: Math.min(bounds.x1, bounds.x2),
    y1: Math.min(bounds.y1, bounds.y2),
    z1: Math.min(bounds.z1, bounds.z2),
    x2: Math.max(bounds.x1, bounds.x2),
    y2: Math.max(bounds.y1, bounds.y2),
    z2: Math.max(bounds.z1, bounds.z2),
  };
}

function axisCount(min: number, max: number, low: number, high: number): number {
  const start = Math.max(min, low);
  const end = Math.min(max, high);
  return end >= start ? end - start + 1 : 0;
}

function volume(bounds: Bounds): number {
  return (bounds.x2 - bounds.x1 + 1) * (bounds.y2 - bounds.y1 + 1) * (bounds.z2 - bounds.z1 + 1);
}

function countInRange(bounds: Bounds, low: number, high: number): number {
  return (
    axisCount(bounds.x1, bounds.x2, low, high) *
    axisCount(bounds.y1, bounds.y2, low, high) *
    axisCount(bounds.z1, bounds.z2, low, high)
  );
}

function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const bounds = {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    z1: Math.max(a.z1, b.z1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
    z2: Math.min(a.z2, b.z2),
  };
  return bounds.x1 <= bounds.x2 && bounds.y1 <= bounds.y2 && bounds.z1 <= bounds.z2 ? bounds : null;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1 && a.z1 <= b.z2 && a.z2 >= b.z1;
}

function covers(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.x1 <= inner.x1 &&
    outer.y1 <= inner.y1 &&
    outer.z1 <= inner.z1 &&
    outer.x2 >= inner.x2 &&
    outer.y2 >= inner.y2 &&
    outer.z2 >= inner.z2
  );
}

function includeBounds(total: Bounds | null, bounds: Bounds): Bounds {
  return total
    ? {
        x1: Math.min(total.x1, bounds.x1),
        y1: Math.min(total.y1, bounds.y1),
        z1: Math.min(total.z1, bounds.z1),
        x2: Math.max(total.x2, bounds.x2),
        y2: Math.max(total.y2, bounds.y2),
        z2: Math.max(total.z2, bounds.z2),
      }
    : { ...bounds };
}

function includeIntersection(total: Bounds | null, a: Bounds, b: Bounds): Bounds | null {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const z1 = Math.max(a.z1, b.z1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const z2 = Math.min(a.z2, b.z2);
  if (x1 > x2 || y1 > y2 || z1 > z2) return null;
  if (!total) return { x1, y1, z1, x2, y2, z2 };
  total.x1 = Math.min(total.x1, x1);
  total.y1 = Math.min(total.y1, y1);
  total.z1 = Math.min(total.z1, z1);
  total.x2 = Math.max(total.x2, x2);
  total.y2 = Math.max(total.y2, y2);
  total.z2 = Math.max(total.z2, z2);
  return total;
}

function toRegionPoint(x: number, y: number, z: number): VoxelPoint {
  return { x, y, z };
}

function toRegionSize(bounds: Bounds): VoxelPoint {
  return toRegionPoint(bounds.x2 - bounds.x1 + 1, bounds.y2 - bounds.y1 + 1, bounds.z2 - bounds.z1 + 1);
}

function boundsFromOriginSize(origin: VoxelPoint, size: VoxelPoint, leafSize: number): Bounds | string {
  if (
    !Number.isInteger(origin.x) ||
    !Number.isInteger(origin.y) ||
    !Number.isInteger(origin.z) ||
    !Number.isInteger(size.x) ||
    !Number.isInteger(size.y) ||
    !Number.isInteger(size.z)
  ) {
    return "Bounds origin and size must be integers";
  }
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    return "Bounds size must be positive";
  }
  if (size.x > leafSize || size.y > leafSize || size.z > leafSize) {
    return `Bounds size must be at most ${leafSize} per axis`;
  }
  return {
    x1: origin.x,
    y1: origin.y,
    z1: origin.z,
    x2: origin.x + size.x - 1,
    y2: origin.y + size.y - 1,
    z2: origin.z + size.z - 1,
  };
}

function pushWarningCounts(
  warnings: string[],
  droppedNegative: number,
  droppedOutOfBounds: number,
  droppedUnknownTypeCounts: Map<string, number>,
) {
  if (droppedNegative > 0) warnings.push(`Dropped ${droppedNegative} blocks with negative coordinates`);
  if (droppedOutOfBounds > 0) warnings.push(`Dropped ${droppedOutOfBounds} blocks outside the grid bounds`);

  if (droppedUnknownTypeCounts.size === 0) return;
  const top = Array.from(droppedUnknownTypeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  for (const [type, count] of top) {
    warnings.push(`Dropped unknown block type: ${type} (${count})`);
  }
  const remaining = droppedUnknownTypeCounts.size - top.length;
  if (remaining > 0) warnings.push(`Dropped ${remaining} additional unknown block types`);
}

function addUnknownType(counts: Map<string, number>, rawType: string, count: number) {
  const key = rawType.trim() ? rawType.trim().toLowerCase() : "(empty)";
  counts.set(key, (counts.get(key) ?? 0) + count);
}

function preprocessBuild(
  build: VoxelBuild,
  opts: VoxelWorldRegionOptions,
): { ok: true; warnings: string[]; operations: PaintOperation[]; boxSources: PackedBoxSource[]; root: Bounds | null; points?: PackedPointSource } | { ok: false; error: string } {
  const allowed = new Set(opts.palette.map((block) => block.id));
  const paletteIndex = new Map(opts.palette.map((block, index) => [block.id, index + 1]));
  const gridExtent = normalizeGridExtent(opts.gridSize);
  const gridBounds = { x1: 0, y1: 0, z1: 0, x2: gridExtent - 1, y2: gridExtent - 1, z2: gridExtent - 1 };
  const operations: PaintOperation[] = [];
  const boxSources: PackedBoxSource[] = [];
  const warnings: string[] = [];
  const droppedUnknownTypeCounts = new Map<string, number>();
  let droppedNegative = 0;
  let droppedOutOfBounds = 0;
  let root: Bounds | null = null;

  const addOperation = (bounds: Bounds, type: string) => {
    const material = paletteIndex.get(type);
    if (material === undefined) return;
    operations.push({ bounds, material, type });
    root = root
      ? {
          x1: Math.min(root.x1, bounds.x1),
          y1: Math.min(root.y1, bounds.y1),
          z1: Math.min(root.z1, bounds.z1),
          x2: Math.max(root.x2, bounds.x2),
          y2: Math.max(root.y2, bounds.y2),
          z2: Math.max(root.z2, bounds.z2),
        }
      : bounds;
  };

  const addValidBounds = (rawBounds: Bounds, type: string) => {
    const bounds = sortedBounds(rawBounds);
    const total = volume(bounds);
    const nonNegative = countInRange(bounds, 0, Number.POSITIVE_INFINITY);
    const inBounds = gridExtent > 0 ? countInRange(bounds, 0, gridExtent - 1) : 0;
    droppedNegative += total - nonNegative;
    droppedOutOfBounds += nonNegative - inBounds;

    const clipped = gridExtent > 0 ? (covers(gridBounds, bounds) ? bounds : intersectBounds(bounds, gridBounds)) : null;
    if (clipped) addOperation(clipped, type);
  };

  const addValidBoxBounds = (rawBounds: Bounds): Bounds | null => {
    const bounds = sortedBounds(rawBounds);
    const total = volume(bounds);
    const nonNegative = countInRange(bounds, 0, Number.POSITIVE_INFINITY);
    const inBounds = gridExtent > 0 ? countInRange(bounds, 0, gridExtent - 1) : 0;
    droppedNegative += total - nonNegative;
    droppedOutOfBounds += nonNegative - inBounds;
    return gridExtent > 0 ? (covers(gridBounds, bounds) ? bounds : intersectBounds(bounds, gridBounds)) : null;
  };

  const addBoxSource = (packed: PackedVoxelBoxes) => {
    if (packed.count === 0) return;
    const materials = Uint16Array.from(packed.typeNames, (type) => {
      const normalized = normalizeBlockType(type, allowed);
      return normalized ? paletteIndex.get(normalized)! : 0;
    });
    let indices = new Uint32Array(Math.min(4096, packed.count));
    let count = 0;
    let bounds: Bounds | null = null;
    const box: PackedVoxelBoxRecord = { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, type: "", typeId: 0 };
    for (let index = 0; index < packed.count; index += 1) {
      if (!readPackedVoxelBox(packed, index, box)) continue;
      const sorted = sortedBounds(box);
      const total = volume(sorted);
      if (!Number.isFinite(total) || total <= 0) continue;
      if (materials[box.typeId] === 0) {
        addUnknownType(droppedUnknownTypeCounts, box.type, total);
        continue;
      }
      const clipped = addValidBoxBounds(sorted);
      if (!clipped) continue;
      if (count === indices.length) {
        const grown = new Uint32Array(indices.length * 2);
        grown.set(indices);
        indices = grown;
      }
      indices[count++] = index;
      bounds = includeBounds(bounds, clipped);
    }
    if (bounds && count > 0) {
      boxSources.push({ packed, materials, indices, count, bounds });
      root = includeBounds(root, bounds);
    }
  };

  if (build.boxes?.length) {
    const packed = createPackedVoxelBoxes();
    appendPackedVoxelBoxes(packed, build.boxes, false);
    addBoxSource(packed);
  }
  if (build.packedBoxes) addBoxSource(build.packedBoxes);

  for (const line of build.lines ?? []) {
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
    const count = Math.max(1, steps + 1);

    const normalizedType = normalizeBlockType(line.type, allowed);
    if (!normalizedType) {
      addUnknownType(droppedUnknownTypeCounts, line.type, count);
      continue;
    }

    for (let i = 0; i <= steps; i += 1) {
      const t = steps <= 0 ? 0 : i / steps;
      const x = Math.round(x1 + dx * t);
      const y = Math.round(y1 + dy * t);
      const z = Math.round(z1 + dz * t);
      addValidBounds({ x1: x, y1: y, z1: z, x2: x, y2: y, z2: z }, normalizedType);
    }
  }

  for (const block of build.blocks) {
    const normalizedType = normalizeBlockType(block.type, allowed);
    if (!normalizedType) {
      addUnknownType(droppedUnknownTypeCounts, block.type, 1);
      continue;
    }
    addValidBounds({ x1: block.x, y1: block.y, z1: block.z, x2: block.x, y2: block.y, z2: block.z }, normalizedType);
  }

  let points: PackedPointSource | undefined;
  if (build.packed) {
    const packed = build.packed;
    const materials = Uint16Array.from(packed.typeNames, (type) => {
      const normalized = normalizeBlockType(type, allowed);
      return normalized ? paletteIndex.get(normalized)! : 0;
    });
    const bounds = { x1: gridExtent, y1: gridExtent, z1: gridExtent, x2: -1, y2: -1, z2: -1 };
    let count = 0;
    for (let index = 0; index < packed.count; index += 1) {
      const typeId = packed.typeIds[index]!;
      if (materials[typeId] === 0) {
        addUnknownType(droppedUnknownTypeCounts, packed.typeNames[typeId]!, 1);
        continue;
      }
      const x = packed.positions[index * 3]!;
      const y = packed.positions[index * 3 + 1]!;
      const z = packed.positions[index * 3 + 2]!;
      if (x < 0 || y < 0 || z < 0) { droppedNegative += 1; continue; }
      if (x >= gridExtent || y >= gridExtent || z >= gridExtent) { droppedOutOfBounds += 1; continue; }
      bounds.x1 = Math.min(bounds.x1, x); bounds.x2 = Math.max(bounds.x2, x);
      bounds.y1 = Math.min(bounds.y1, y); bounds.y2 = Math.max(bounds.y2, y);
      bounds.z1 = Math.min(bounds.z1, z); bounds.z2 = Math.max(bounds.z2, z);
      count += 1;
    }
    if (count > 0) {
      points = { packed, materials, bounds, count };
      root = includeBounds(root, bounds);
    }
  }

  pushWarningCounts(warnings, droppedNegative, droppedOutOfBounds, droppedUnknownTypeCounts);
  return { ok: true, warnings, operations, boxSources, root, points };
}

function filterPackedBoxes(range: PackedBoxRange, bounds: Bounds): PackedBoxRange | undefined {
  const clipped = intersectBounds(range.bounds, bounds);
  if (!clipped) return undefined;
  let indices = new Uint32Array(Math.min(4096, range.end - range.start));
  let count = 0;
  let occupied: Bounds | null = null;
  const box: PackedVoxelBoxRecord = { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, type: "", typeId: 0 };
  for (let index = range.start; index < range.end; index += 1) {
    const boxIndex = range.indices[index]!;
    if (!readPackedVoxelBox(range.source.packed, boxIndex, box)) continue;
    if (range.source.materials[box.typeId] === 0) continue;
    const nextBounds = includeIntersection(occupied, sortedBounds(box), clipped);
    if (!nextBounds) continue;
    if (count === indices.length) {
      const grown = new Uint32Array(indices.length * 2);
      grown.set(indices);
      indices = grown;
    }
    indices[count++] = boxIndex;
    occupied = nextBounds;
  }
  return occupied && count > 0 ? { source: range.source, indices, start: 0, end: count, bounds: occupied } : undefined;
}

function collectPackedBoxes(source: PackedBoxSource, bounds: Bounds): PackedBoxRange | undefined {
  const clipped = intersectBounds(source.bounds, bounds);
  if (!clipped) return undefined;
  if (covers(bounds, source.bounds)) {
    return { source, indices: source.indices, start: 0, end: source.count, bounds: source.bounds };
  }
  return filterPackedBoxes({ source, indices: source.indices, start: 0, end: source.count, bounds: source.bounds }, clipped);
}

function collectPackedBoxRanges(sources: readonly PackedBoxSource[], bounds: Bounds): PackedBoxRange[] {
  return sources.flatMap((source) => {
    const range = collectPackedBoxes(source, bounds);
    return range ? [range] : [];
  });
}

function filterPackedBoxRanges(ranges: readonly PackedBoxRange[], bounds: Bounds): PackedBoxRange[] {
  return ranges.flatMap((range) => {
    const child = filterPackedBoxes(range, bounds);
    return child ? [child] : [];
  });
}

function collectPackedPoints(source: PackedPointSource | undefined, bounds: Bounds): PackedPointRange | undefined {
  if (!source) return undefined;
  const clipped = intersectBounds(source.bounds, bounds);
  if (!clipped) return undefined;
  const { packed, materials } = source;
  let indices = new Uint32Array(covers(bounds, source.bounds) ? source.count : Math.min(4096, source.count));
  let count = 0;
  const occupied = { x1: clipped.x2, y1: clipped.y2, z1: clipped.z2, x2: clipped.x1, y2: clipped.y1, z2: clipped.z1 };
  for (let index = 0; index < packed.count; index += 1) {
    const offset = index * 3;
    const x = packed.positions[offset]!;
    const y = packed.positions[offset + 1]!;
    const z = packed.positions[offset + 2]!;
    if (materials[packed.typeIds[index]!] === 0 || x < clipped.x1 || x > clipped.x2 || y < clipped.y1 || y > clipped.y2 || z < clipped.z1 || z > clipped.z2) continue;
    if (count === indices.length) {
      const grown = new Uint32Array(indices.length * 2);
      grown.set(indices);
      indices = grown;
    }
    indices[count++] = index;
    occupied.x1 = Math.min(occupied.x1, x); occupied.x2 = Math.max(occupied.x2, x);
    occupied.y1 = Math.min(occupied.y1, y); occupied.y2 = Math.max(occupied.y2, y);
    occupied.z1 = Math.min(occupied.z1, z); occupied.z2 = Math.max(occupied.z2, z);
  }
  return count > 0 ? { source, indices, start: 0, end: count, bounds: occupied } : undefined;
}

// partition one index buffer in place and restore write order only in bounded leaves
function partitionPackedPoints(points: PackedPointRange, bounds: Bounds, start: number): PackedPointRange | undefined {
  const { indices, source } = points;
  const positions = source.packed.positions;
  let end = start;
  let x1 = bounds.x2, y1 = bounds.y2, z1 = bounds.z2;
  let x2 = bounds.x1, y2 = bounds.y1, z2 = bounds.z1;
  for (let index = start; index < points.end; index += 1) {
    const point = indices[index]!;
    const offset = point * 3;
    const x = positions[offset]!, y = positions[offset + 1]!, z = positions[offset + 2]!;
    if (x < bounds.x1 || x > bounds.x2 || y < bounds.y1 || y > bounds.y2 || z < bounds.z1 || z > bounds.z2) continue;
    indices[index] = indices[end]!;
    indices[end++] = point;
    x1 = Math.min(x1, x); x2 = Math.max(x2, x);
    y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    z1 = Math.min(z1, z); z2 = Math.max(z2, z);
  }
  return end > start ? { source, indices, start, end, bounds: { x1, y1, z1, x2, y2, z2 } } : undefined;
}

function uniformMaterialFor(bounds: Bounds, operations: PaintOperation[], boxRanges: readonly PackedBoxRange[]): number | null {
  const laterMaterials = new Set<number>();
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]!;
    if (!intersects(operation.bounds, bounds)) continue;
    if (covers(operation.bounds, bounds)) {
      if (laterMaterials.size === 0 || (laterMaterials.size === 1 && laterMaterials.has(operation.material))) {
        return operation.material;
      }
      return null;
    }
    laterMaterials.add(operation.material);
  }
  const box: PackedVoxelBoxRecord = { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, type: "", typeId: 0 };
  for (let rangeIndex = boxRanges.length - 1; rangeIndex >= 0; rangeIndex -= 1) {
    const range = boxRanges[rangeIndex]!;
    for (let index = range.end - 1; index >= range.start; index -= 1) {
      if (!readPackedVoxelBox(range.source.packed, range.indices[index]!, box)) continue;
      const material = range.source.materials[box.typeId]!;
      if (material === 0) continue;
      const boundsForBox = sortedBounds(box);
      if (!intersects(boundsForBox, bounds)) continue;
      if (covers(boundsForBox, bounds)) {
        if (laterMaterials.size === 0 || (laterMaterials.size === 1 && laterMaterials.has(material))) {
          return material;
        }
        return null;
      }
      laterMaterials.add(material);
    }
  }
  return null;
}

function splitAxis(min: number, max: number, leafSize: number): [number, number][] {
  if (max - min + 1 <= leafSize) return [[min, max]];
  const mid = Math.floor((min + max) / 2);
  return [
    [min, mid],
    [mid + 1, max],
  ];
}

function makeMaterialArray(length: number, paletteSize: number): Uint8Array | Uint16Array {
  return paletteSize <= 255 ? new Uint8Array(length) : new Uint16Array(length);
}

function evaluateMixedLeaf(
  bounds: Bounds,
  boxRanges: readonly PackedBoxRange[],
  operations: PaintOperation[],
  palette: BlockDefinition[],
  points?: PackedPointRange,
): VoxelWorldRegion | null {
  const sx = bounds.x2 - bounds.x1 + 1;
  const sy = bounds.y2 - bounds.y1 + 1;
  const strideZ = sx * sy;
  const materialIndexes = makeMaterialArray(volume(bounds), palette.length);
  const materialCounts = new Uint32Array(palette.length + 1);
  let blockCount = 0;

  const paint = (paintBounds: Bounds, material: number) => {
    const clipped = intersectBounds(bounds, paintBounds);
    if (!clipped) return;
    for (let z = clipped.z1; z <= clipped.z2; z += 1) {
      const zOffset = (z - bounds.z1) * strideZ;
      for (let y = clipped.y1; y <= clipped.y2; y += 1) {
        let index = zOffset + (y - bounds.y1) * sx + (clipped.x1 - bounds.x1);
        for (let x = clipped.x1; x <= clipped.x2; x += 1) {
          const previous = materialIndexes[index]!;
          if (previous === material) {
            index += 1;
            continue;
          }
          if (previous === 0) blockCount += 1;
          else materialCounts[previous] -= 1;
          materialIndexes[index] = material;
          materialCounts[material] += 1;
          index += 1;
        }
      }
    }
  };

  const box: PackedVoxelBoxRecord = { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, type: "", typeId: 0 };
  for (const range of boxRanges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (!readPackedVoxelBox(range.source.packed, range.indices[index]!, box)) continue;
      const material = range.source.materials[box.typeId]!;
      if (material !== 0) paint(sortedBounds(box), material);
    }
  }

  for (const operation of operations) {
    paint(operation.bounds, operation.material);
  }

  if (points) {
    const { packed, materials } = points.source;
    points.indices.subarray(points.start, points.end).sort();
    for (let i = points.start; i < points.end; i += 1) {
      const point = points.indices[i]!;
      const offset = point * 3;
      const index = packed.positions[offset]! - bounds.x1 +
        (packed.positions[offset + 1]! - bounds.y1) * sx + (packed.positions[offset + 2]! - bounds.z1) * strideZ;
      const material = materials[packed.typeIds[point]!]!;
      const previous = materialIndexes[index]!;
      if (previous === material) continue;
      if (previous === 0) blockCount += 1;
      else materialCounts[previous] -= 1;
      materialIndexes[index] = material;
      materialCounts[material] += 1;
    }
  }

  if (blockCount === 0) return null;
  const origin = toRegionPoint(bounds.x1, bounds.y1, bounds.z1);
  const size = toRegionSize(bounds);
  if (blockCount === materialIndexes.length) {
    let uniformMaterial = 0;
    for (let material = 1; material < materialCounts.length; material += 1) {
      if (materialCounts[material] === 0) continue;
      if (uniformMaterial !== 0) {
        uniformMaterial = 0;
        break;
      }
      uniformMaterial = material;
    }
    if (uniformMaterial !== 0) {
      return { kind: "uniform", origin, size, type: palette[uniformMaterial - 1]!.id, blockCount };
    }
  }

  return { kind: "mixed", origin, size, materialIndexes, blockCount };
}

function* evaluateNode(
  bounds: Bounds,
  operations: PaintOperation[],
  boxRanges: PackedBoxRange[],
  palette: BlockDefinition[],
  leafSize: number,
  points?: PackedPointRange,
): Generator<VoxelWorldRegion> {
  if (operations.length === 0 && boxRanges.length === 0 && !points) return;

  // trim empty margins so a thin floor remains a uniform region
  let occupied: Bounds | null = points ? { ...points.bounds } : null;
  for (const boxRange of boxRanges) occupied = includeBounds(occupied, boxRange.bounds);
  for (const operation of operations) {
    occupied = includeIntersection(occupied, bounds, operation.bounds) ?? occupied;
  }
  if (!occupied) return;
  bounds = occupied;

  const uniformMaterial = points ? null : uniformMaterialFor(bounds, operations, boxRanges);
  if (uniformMaterial !== null) {
    const type = palette[uniformMaterial - 1]?.id;
    if (type) {
      yield {
        kind: "uniform",
        origin: toRegionPoint(bounds.x1, bounds.y1, bounds.z1),
        size: toRegionSize(bounds),
        type,
        blockCount: volume(bounds),
      };
    }
    return;
  }

  const size = toRegionSize(bounds);
  if (size.x <= leafSize && size.y <= leafSize && size.z <= leafSize) {
    const region = evaluateMixedLeaf(bounds, boxRanges, operations, palette, points);
    if (region) yield region;
    return;
  }

  const xRanges = splitAxis(bounds.x1, bounds.x2, leafSize);
  const yRanges = splitAxis(bounds.y1, bounds.y2, leafSize);
  const zRanges = splitAxis(bounds.z1, bounds.z2, leafSize);
  let pointStart = points?.start ?? 0;
  for (const [z1, z2] of zRanges) {
    for (const [y1, y2] of yRanges) {
      for (const [x1, x2] of xRanges) {
        const child = { x1, y1, z1, x2, y2, z2 };
        const childPoints = points ? partitionPackedPoints(points, child, pointStart) : undefined;
        if (childPoints) pointStart = childPoints.end;
        const childBoxRanges = filterPackedBoxRanges(boxRanges, child);
        const shouldTighten =
          x2 - x1 + 1 <= leafSize &&
          y2 - y1 + 1 <= leafSize &&
          z2 - z1 + 1 <= leafSize;
        if (!shouldTighten) {
          const childOperations = operations.filter((operation) => intersects(operation.bounds, child));
          yield* evaluateNode(child, childOperations, childBoxRanges, palette, leafSize, childPoints);
          continue;
        }

        const childOperations: PaintOperation[] = [];
        let childBounds: Bounds | null = childPoints ? { ...childPoints.bounds } : null;
        for (const boxRange of childBoxRanges) childBounds = includeBounds(childBounds, boxRange.bounds);
        for (const operation of operations) {
          const nextBounds = includeIntersection(childBounds, operation.bounds, child);
          if (!nextBounds) continue;
          childOperations.push(operation);
          childBounds = nextBounds;
        }
        if (childBounds) yield* evaluateNode(childBounds, childOperations, childBoxRanges, palette, leafSize, childPoints);
      }
    }
  }
}

function regionsIterable(
  root: Bounds | null,
  operations: PaintOperation[],
  boxSources: PackedBoxSource[],
  palette: BlockDefinition[],
  leafSize: number,
  points?: PackedPointSource,
): Iterable<VoxelWorldRegion> {
  return {
    [Symbol.iterator]() {
      return root
        ? evaluateNode(root, operations, collectPackedBoxRanges(boxSources, root), palette, leafSize, collectPackedPoints(points, root))
        : [][Symbol.iterator]();
    },
  };
}

function createEvaluatorFromBuild(
  build: VoxelBuild,
  opts: VoxelWorldRegionOptions,
): { ok: true; value: VoxelWorldRegionEvaluator } | { ok: false; error: string } {
  const prepared = preprocessBuild(build, opts);
  if (!prepared.ok) return prepared;

  const leafSize = normalizeLeafSize(opts.mixedLeafSize);
  return {
    ok: true,
    value: {
      warnings: prepared.warnings,
      regions: regionsIterable(prepared.root, prepared.operations, prepared.boxSources, opts.palette, leafSize, prepared.points),
      evaluateBounds(origin, size) {
        const bounds = boundsFromOriginSize(origin, size, leafSize);
        if (typeof bounds === "string") return { ok: false, error: bounds };
        const operations = prepared.operations.filter((operation) => intersects(operation.bounds, bounds));
        const boxRanges = collectPackedBoxRanges(prepared.boxSources, bounds);
        const points = collectPackedPoints(prepared.points, bounds);
        const region = operations.length > 0 || boxRanges.length > 0 || points
          ? Array.from(evaluateNode(bounds, operations, boxRanges, opts.palette, leafSize, points))[0] ?? null
          : null;
        return { ok: true, region };
      },
    },
  };
}

export function createVoxelWorldRegionEvaluator(
  input: unknown,
  opts: VoxelWorldRegionOptions,
): { ok: true; value: VoxelWorldRegionEvaluator } | { ok: false; error: string } {
  const parsed = parseVoxelBuildSpec(input);
  if (!parsed.ok) return parsed;
  return createEvaluatorFromBuild(parsed.value, opts);
}

export function evaluateVoxelWorldRegions(
  input: unknown,
  opts: VoxelWorldRegionOptions,
): VoxelWorldRegionEvaluation {
  const evaluator = createVoxelWorldRegionEvaluator(input, opts);
  if (!evaluator.ok) return evaluator;
  return { ok: true, warnings: evaluator.value.warnings, regions: evaluator.value.regions };
}

// retain the compact source while counting disjoint regions without expanding the world
export function summarizeVoxelWorldRegions(input: unknown, opts: VoxelWorldRegionOptions) {
  const parsed = parseVoxelBuildSpec(input);
  if (!parsed.ok) return parsed;
  const evaluator = createEvaluatorFromBuild(parsed.value, opts);
  if (!evaluator.ok) return evaluator;
  let blockCount = 0;
  let bounds: { origin: VoxelPoint; size: VoxelPoint } | null = null;
  for (const region of evaluator.value.regions) {
    blockCount += region.blockCount;
    if (!bounds) {
      bounds = { origin: { ...region.origin }, size: { ...region.size } };
      continue;
    }
    for (const axis of ["x", "y", "z"] as const) {
      const end = Math.max(bounds.origin[axis] + bounds.size[axis], region.origin[axis] + region.size[axis]);
      bounds.origin[axis] = Math.min(bounds.origin[axis], region.origin[axis]);
      bounds.size[axis] = end - bounds.origin[axis];
    }
  }
  return { ok: true as const, value: { build: parsed.value, warnings: evaluator.value.warnings, blockCount, bounds } };
}
