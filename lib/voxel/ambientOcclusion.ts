import type { Face } from "@/lib/blocks/textures";
import {
  encodeVoxelPositionKey,
  hashVoxelPositionKey,
  MAX_VOXEL_COORDINATE,
} from "@/lib/voxel/coordinateKeys";

export type CornerOffset = {
  readonly sideA: readonly [number, number, number];
  readonly sideB: readonly [number, number, number];
  readonly diag: readonly [number, number, number];
};

export type Direction = {
  readonly face: Face;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly quad: (x: number, y: number, z: number) => [number, number, number][];
  readonly corners: readonly [CornerOffset, CornerOffset, CornerOffset, CornerOffset];
};

export type SpatialBlockLookup = {
  get(x: number, y: number, z: number): number;
};

export const DIRS: readonly Direction[] = [
  {
    face: "east",
    dx: 1,
    dy: 0,
    dz: 0,
    nx: 1,
    ny: 0,
    nz: 0,
    quad: (x, y, z) => [
      [x + 1, y, z],
      [x + 1, y + 1, z],
      [x + 1, y + 1, z + 1],
      [x + 1, y, z + 1],
    ],
    corners: [
      { sideA: [0, -1, 0], sideB: [0, 0, -1], diag: [0, -1, -1] },
      { sideA: [0, 1, 0], sideB: [0, 0, -1], diag: [0, 1, -1] },
      { sideA: [0, 1, 0], sideB: [0, 0, 1], diag: [0, 1, 1] },
      { sideA: [0, -1, 0], sideB: [0, 0, 1], diag: [0, -1, 1] },
    ],
  },
  {
    face: "west",
    dx: -1,
    dy: 0,
    dz: 0,
    nx: -1,
    ny: 0,
    nz: 0,
    quad: (x, y, z) => [
      [x, y, z + 1],
      [x, y + 1, z + 1],
      [x, y + 1, z],
      [x, y, z],
    ],
    corners: [
      { sideA: [0, -1, 0], sideB: [0, 0, 1], diag: [0, -1, 1] },
      { sideA: [0, 1, 0], sideB: [0, 0, 1], diag: [0, 1, 1] },
      { sideA: [0, 1, 0], sideB: [0, 0, -1], diag: [0, 1, -1] },
      { sideA: [0, -1, 0], sideB: [0, 0, -1], diag: [0, -1, -1] },
    ],
  },
  {
    face: "north",
    dx: 0,
    dy: 0,
    dz: -1,
    nx: 0,
    ny: 0,
    nz: -1,
    quad: (x, y, z) => [
      [x, y, z],
      [x, y + 1, z],
      [x + 1, y + 1, z],
      [x + 1, y, z],
    ],
    corners: [
      { sideA: [-1, 0, 0], sideB: [0, -1, 0], diag: [-1, -1, 0] },
      { sideA: [-1, 0, 0], sideB: [0, 1, 0], diag: [-1, 1, 0] },
      { sideA: [1, 0, 0], sideB: [0, 1, 0], diag: [1, 1, 0] },
      { sideA: [1, 0, 0], sideB: [0, -1, 0], diag: [1, -1, 0] },
    ],
  },
  {
    face: "south",
    dx: 0,
    dy: 0,
    dz: 1,
    nx: 0,
    ny: 0,
    nz: 1,
    quad: (x, y, z) => [
      [x + 1, y, z + 1],
      [x + 1, y + 1, z + 1],
      [x, y + 1, z + 1],
      [x, y, z + 1],
    ],
    corners: [
      { sideA: [1, 0, 0], sideB: [0, -1, 0], diag: [1, -1, 0] },
      { sideA: [1, 0, 0], sideB: [0, 1, 0], diag: [1, 1, 0] },
      { sideA: [-1, 0, 0], sideB: [0, 1, 0], diag: [-1, 1, 0] },
      { sideA: [-1, 0, 0], sideB: [0, -1, 0], diag: [-1, -1, 0] },
    ],
  },
  {
    face: "up",
    dx: 0,
    dy: 1,
    dz: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    quad: (x, y, z) => [
      [x, y + 1, z + 1],
      [x + 1, y + 1, z + 1],
      [x + 1, y + 1, z],
      [x, y + 1, z],
    ],
    corners: [
      { sideA: [-1, 0, 0], sideB: [0, 0, 1], diag: [-1, 0, 1] },
      { sideA: [1, 0, 0], sideB: [0, 0, 1], diag: [1, 0, 1] },
      { sideA: [1, 0, 0], sideB: [0, 0, -1], diag: [1, 0, -1] },
      { sideA: [-1, 0, 0], sideB: [0, 0, -1], diag: [-1, 0, -1] },
    ],
  },
  {
    face: "down",
    dx: 0,
    dy: -1,
    dz: 0,
    nx: 0,
    ny: -1,
    nz: 0,
    quad: (x, y, z) => [
      [x, y, z],
      [x + 1, y, z],
      [x + 1, y, z + 1],
      [x, y, z + 1],
    ],
    corners: [
      { sideA: [-1, 0, 0], sideB: [0, 0, -1], diag: [-1, 0, -1] },
      { sideA: [1, 0, 0], sideB: [0, 0, -1], diag: [1, 0, -1] },
      { sideA: [1, 0, 0], sideB: [0, 0, 1], diag: [1, 0, 1] },
      { sideA: [-1, 0, 0], sideB: [0, 0, 1], diag: [-1, 0, 1] },
    ],
  },
];

const EMPTY_SLOT = -1;
const SMALL_COORDINATE_MAX = 1023;
const SMALL_EMPTY_SLOT = 0xffffffff;

function areTableCoordinatesInRange(x: number, y: number, z: number): boolean {
  // Mesh inputs are validated integers; keep the hot neighbor path to bounds checks.
  return (
    x >= 0 &&
    x <= MAX_VOXEL_COORDINATE &&
    y >= 0 &&
    y <= MAX_VOXEL_COORDINATE &&
    z >= 0 &&
    z <= MAX_VOXEL_COORDINATE
  );
}

function areSmallTableCoordinates(x: number, y: number, z: number): boolean {
  return x <= SMALL_COORDINATE_MAX && y <= SMALL_COORDINATE_MAX && z <= SMALL_COORDINATE_MAX;
}

function encodeSmallPositionKey(x: number, y: number, z: number): number {
  return ((x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20)) >>> 0;
}

function decodeSmallPositionKey(value: number): [number, number, number] {
  return [value & 1023, (value >>> 10) & 1023, (value >>> 20) & 1023];
}

export class SpatialBlockTable {
  private smallKeys: Uint32Array | null;
  private wideKeys: Float64Array | null;
  private values: Uint16Array;
  private readonly mask: number;

  constructor(capacity: number) {
    const minCap = Math.max(64, Math.ceil(Math.max(1, capacity) / 0.7));
    const size = 1 << Math.ceil(Math.log2(minCap));
    this.mask = size - 1;
    this.smallKeys = new Uint32Array(size);
    this.smallKeys.fill(SMALL_EMPTY_SLOT);
    this.wideKeys = null;
    this.values = new Uint16Array(size);
  }

  private upgradeToWideKeys(): void {
    if (this.wideKeys) return;

    const oldKeys = this.smallKeys;
    const oldValues = this.values;
    const wideKeys = new Float64Array(oldValues.length);
    const values = new Uint16Array(oldValues.length);
    wideKeys.fill(EMPTY_SLOT);
    if (oldKeys) {
      for (let oldIndex = 0; oldIndex < oldKeys.length; oldIndex += 1) {
        const oldKey = oldKeys[oldIndex];
        if (oldKey === SMALL_EMPTY_SLOT) continue;
        const [x, y, z] = decodeSmallPositionKey(oldKey);
        const key = encodeVoxelPositionKey(x, y, z);
        let index = hashVoxelPositionKey(x, y, z) & this.mask;
        while (wideKeys[index] !== EMPTY_SLOT) {
          index = (index + 1) & this.mask;
        }
        wideKeys[index] = key;
        values[index] = oldValues[oldIndex];
      }
    }
    this.smallKeys = null;
    this.wideKeys = wideKeys;
    this.values = values;
  }

  set(x: number, y: number, z: number, typeId: number): void {
    if (!areTableCoordinatesInRange(x, y, z)) return;
    if (this.smallKeys && areSmallTableCoordinates(x, y, z)) {
      const key = encodeSmallPositionKey(x, y, z);
      let index = (Math.imul(key, 0x9e3779b9) >>> 0) & this.mask;
      while (this.smallKeys[index] !== SMALL_EMPTY_SLOT && this.smallKeys[index] !== key) {
        index = (index + 1) & this.mask;
      }
      this.smallKeys[index] = key;
      this.values[index] = typeId;
      return;
    }

    this.upgradeToWideKeys();
    const key = encodeVoxelPositionKey(x, y, z);
    let index = hashVoxelPositionKey(x, y, z) & this.mask;
    const keys = this.wideKeys!;
    while (keys[index] !== EMPTY_SLOT && keys[index] !== key) {
      index = (index + 1) & this.mask;
    }
    keys[index] = key;
    this.values[index] = typeId;
  }

  get(x: number, y: number, z: number): number {
    if (!areTableCoordinatesInRange(x, y, z)) return -1;
    if (this.smallKeys) {
      if (!areSmallTableCoordinates(x, y, z)) return -1;
      const key = encodeSmallPositionKey(x, y, z);
      let index = (Math.imul(key, 0x9e3779b9) >>> 0) & this.mask;
      while (true) {
        const stored = this.smallKeys[index];
        if (stored === SMALL_EMPTY_SLOT) return -1;
        if (stored === key) return this.values[index];
        index = (index + 1) & this.mask;
      }
    }

    const key = encodeVoxelPositionKey(x, y, z);
    let index = hashVoxelPositionKey(x, y, z) & this.mask;
    const keys = this.wideKeys!;
    while (true) {
      const stored = keys[index];
      if (stored === EMPTY_SLOT) return -1;
      if (stored === key) return this.values[index];
      index = (index + 1) & this.mask;
    }
  }
}

export function isOccludingAt(
  table: SpatialBlockLookup,
  materialOccluding: Uint8Array,
  x: number,
  y: number,
  z: number,
): boolean {
  const tid = table.get(x, y, z);
  return tid !== -1 && materialOccluding[tid] === 1;
}

export function computeVisibleFaceMask(
  x: number,
  y: number,
  z: number,
  typeId: number,
  table: SpatialBlockLookup,
  materialOccluding: Uint8Array,
): number {
  let mask = 0;
  for (let dIdx = 0; dIdx < DIRS.length; dIdx += 1) {
    const direction = DIRS[dIdx];
    const neighborTypeId = table.get(
      x + direction.dx,
      y + direction.dy,
      z + direction.dz,
    );
    if (
      neighborTypeId === -1 ||
      (neighborTypeId !== typeId && materialOccluding[neighborTypeId] !== 1)
    ) {
      mask |= 1 << dIdx;
    }
  }
  return mask;
}

function cornerFactor(
  corner: CornerOffset,
  ox: number,
  oy: number,
  oz: number,
  table: SpatialBlockLookup,
  materialOccluding: Uint8Array,
  sA: boolean,
  sB: boolean,
): number {
  if (sA && sB) return 0.58;
  const sD = isOccludingAt(table, materialOccluding, ox + corner.diag[0], oy + corner.diag[1], oz + corner.diag[2]);
  const level = 3 - ((sA ? 1 : 0) + (sB ? 1 : 0) + (sD ? 1 : 0));
  return 0.58 + (level / 3.0) * 0.42;
}

export function computeFaceAO(
  d: Direction,
  bx: number,
  by: number,
  bz: number,
  table: SpatialBlockLookup,
  materialOccluding: Uint8Array,
): readonly [number, number, number, number] {
  const ox = bx + d.dx;
  const oy = by + d.dy;
  const oz = bz + d.dz;
  const first = d.corners[0];
  const opposite = d.corners[2];
  const a0 = isOccludingAt(table, materialOccluding, ox + first.sideA[0], oy + first.sideA[1], oz + first.sideA[2]);
  const b0 = isOccludingAt(table, materialOccluding, ox + first.sideB[0], oy + first.sideB[1], oz + first.sideB[2]);
  const a1 = isOccludingAt(table, materialOccluding, ox + opposite.sideA[0], oy + opposite.sideA[1], oz + opposite.sideA[2]);
  const b1 = isOccludingAt(table, materialOccluding, ox + opposite.sideB[0], oy + opposite.sideB[1], oz + opposite.sideB[2]);
  // z-facing corners vary sideB before sideA to preserve their winding
  const sideBFirst = d.dz !== 0;

  return [
    cornerFactor(first, ox, oy, oz, table, materialOccluding, a0, b0),
    cornerFactor(d.corners[1], ox, oy, oz, table, materialOccluding, sideBFirst ? a0 : a1, sideBFirst ? b1 : b0),
    cornerFactor(opposite, ox, oy, oz, table, materialOccluding, a1, b1),
    cornerFactor(d.corners[3], ox, oy, oz, table, materialOccluding, sideBFirst ? a1 : a0, sideBFirst ? b0 : b1),
  ];
}

export function canBlockEmitAnyFace(
  x: number,
  y: number,
  z: number,
  typeId: number,
  table: SpatialBlockLookup,
  materialOccluding: Uint8Array,
): boolean {
  for (const d of DIRS) {
    const neighborTypeId = table.get(x + d.dx, y + d.dy, z + d.dz);
    if (neighborTypeId === -1) return true;
    if (neighborTypeId === typeId) continue;
    if (materialOccluding[neighborTypeId] === 1) continue;
    return true;
  }
  return false;
}
