import type { Face } from "@/lib/blocks/textures";

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

const EMPTY_SLOT = 0xffffffff;

export class SpatialBlockTable {
  private readonly keys: Uint32Array;
  private readonly values: Uint16Array;
  private readonly mask: number;

  constructor(capacity: number) {
    const minCap = Math.max(64, Math.ceil(Math.max(1, capacity) / 0.7));
    const size = 1 << Math.ceil(Math.log2(minCap));
    this.mask = size - 1;
    this.keys = new Uint32Array(size);
    this.keys.fill(EMPTY_SLOT);
    this.values = new Uint16Array(size);
  }

  set(x: number, y: number, z: number, typeId: number): void {
    const key = ((x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20)) >>> 0;
    let index = (Math.imul(key, 0x9e3779b9) >>> 0) & this.mask;
    while (this.keys[index] !== EMPTY_SLOT && this.keys[index] !== key) {
      index = (index + 1) & this.mask;
    }
    this.keys[index] = key;
    this.values[index] = typeId;
  }

  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x > 1023 || y > 1023 || z > 1023) return -1;
    const key = ((x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20)) >>> 0;
    let index = (Math.imul(key, 0x9e3779b9) >>> 0) & this.mask;
    while (true) {
      const stored = this.keys[index];
      if (stored === EMPTY_SLOT) return -1;
      if (stored === key) return this.values[index];
      index = (index + 1) & this.mask;
    }
  }
}

export function isOccludingAt(
  table: SpatialBlockTable,
  materialOccluding: Uint8Array,
  x: number,
  y: number,
  z: number,
): boolean {
  const tid = table.get(x, y, z);
  return tid !== -1 && materialOccluding[tid] === 1;
}

function cornerFactor(
  corner: CornerOffset,
  ox: number,
  oy: number,
  oz: number,
  table: SpatialBlockTable,
  materialOccluding: Uint8Array,
): number {
  const sA = isOccludingAt(table, materialOccluding, ox + corner.sideA[0], oy + corner.sideA[1], oz + corner.sideA[2]);
  const sB = isOccludingAt(table, materialOccluding, ox + corner.sideB[0], oy + corner.sideB[1], oz + corner.sideB[2]);
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
  table: SpatialBlockTable,
  materialOccluding: Uint8Array,
): readonly [number, number, number, number] {
  const ox = bx + d.dx;
  const oy = by + d.dy;
  const oz = bz + d.dz;

  return [
    cornerFactor(d.corners[0], ox, oy, oz, table, materialOccluding),
    cornerFactor(d.corners[1], ox, oy, oz, table, materialOccluding),
    cornerFactor(d.corners[2], ox, oy, oz, table, materialOccluding),
    cornerFactor(d.corners[3], ox, oy, oz, table, materialOccluding),
  ];
}

export function canBlockEmitAnyFace(
  x: number,
  y: number,
  z: number,
  typeId: number,
  table: SpatialBlockTable,
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
