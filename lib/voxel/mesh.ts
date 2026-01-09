import * as THREE from "three";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getRenderKind } from "@/lib/blocks/registry";
import { getAtlasUv, hasAtlasKey } from "@/lib/blocks/atlas";
import { Face, getTextureKey } from "@/lib/blocks/textures";
import type { VoxelBuild } from "@/lib/voxel/types";

type MeshBucket = {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
};

function makeBucket(): MeshBucket {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

type Direction = {
  face: Face;
  dx: number;
  dy: number;
  dz: number;
  nx: number;
  ny: number;
  nz: number;
  quad: (x: number, y: number, z: number) => [number, number, number][];
};

const DIRS: Direction[] = [
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
  },
];

function buildGeometry(bucket: MeshBucket): THREE.BufferGeometry | null {
  if (bucket.indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(bucket.positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(bucket.normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(bucket.uvs, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(bucket.colors, 3));
  geo.setIndex(bucket.indices);
  geo.computeBoundingSphere();
  return geo;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  });
}

export type VoxelGroup = {
  group: THREE.Group;
  dispose: () => void;
  stats: { blockCount: number };
};

export function createVoxelGroup(build: VoxelBuild, palette: BlockDefinition[], atlasTexture: THREE.Texture): VoxelGroup {
  const allowed = new Set(palette.map((p) => p.id));

  const blocks = build.blocks.filter((b) => allowed.has(b.type));
  // 8 bits per coordinate supports up to 256³ grids.
  const encode = (x: number, y: number, z: number) => x | (y << 8) | (z << 16);
  const occupied = new Set<number>();
  for (const b of blocks) occupied.add(encode(b.x, b.y, b.z));

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of blocks) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x);
    maxY = Math.max(maxY, b.y);
    maxZ = Math.max(maxZ, b.z);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }
  const cx = (minX + maxX + 1) / 2;
  // Keep the build grounded (y=0) while still centering in X/Z for consistent framing.
  const cy = minY;
  const cz = (minZ + maxZ + 1) / 2;

  const opaque = makeBucket();
  const cutout = makeBucket();
  const transparent = makeBucket();
  const emissive = makeBucket();

  function bucketFor(blockType: string): MeshBucket {
    const kind = getRenderKind(blockType) ?? "opaque";
    if (kind === "transparent") return transparent;
    if (kind === "cutout") return cutout;
    if (kind === "emissive") return emissive;
    return opaque;
  }

  function srgbByteToLinear(byte: number): number {
    const s = Math.min(1, Math.max(0, byte / 255));
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function hexToLinearRgb(hex: number): [number, number, number] {
    return [
      srgbByteToLinear((hex >> 16) & 0xff),
      srgbByteToLinear((hex >> 8) & 0xff),
      srgbByteToLinear(hex & 0xff),
    ];
  }

  const tintLeaves = hexToLinearRgb(0x48b518);
  const tintGrass = hexToLinearRgb(0x7fb238);
  const tintWater = hexToLinearRgb(0x3f76e4);
  const tintWhite: [number, number, number] = [1, 1, 1];

  function faceTint(blockType: string, face: Face): [number, number, number] {
    if (blockType === "oak_leaves") return tintLeaves;
    if (blockType === "water") return tintWater;
    if (blockType === "grass_block" && face === "up") return tintGrass;
    return tintWhite;
  }

  for (const b of blocks) {
    const bx = b.x - cx;
    const by = b.y - cy;
    const bz = b.z - cz;

    for (const d of DIRS) {
      const nx = b.x + d.dx;
      const ny = b.y + d.dy;
      const nz = b.z + d.dz;
      if (occupied.has(encode(nx, ny, nz))) continue;

      const texKey = getTextureKey(b.type, d.face);
      if (!hasAtlasKey(texKey)) continue;
      const uv = getAtlasUv(texKey);
      const tint = faceTint(b.type, d.face);

      const verts = d.quad(bx, by, bz);
      const bucket = bucketFor(b.type);
      const baseIndex = bucket.positions.length / 3;
      for (const [vx, vy, vz] of verts) {
        bucket.positions.push(vx, vy, vz);
        bucket.normals.push(d.nx, d.ny, d.nz);
        bucket.colors.push(tint[0], tint[1], tint[2]);
      }

      bucket.uvs.push(
        uv.u0, uv.v0,
        uv.u0, uv.v1,
        uv.u1, uv.v1,
        uv.u1, uv.v0
      );

      bucket.indices.push(
        baseIndex, baseIndex + 1, baseIndex + 2,
        baseIndex, baseIndex + 2, baseIndex + 3
      );
    }
  }

  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;

  const matOpaque = new THREE.MeshStandardMaterial({ map: atlasTexture, vertexColors: true });
  const matCutout = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    alphaTest: 0.45,
    vertexColors: true,
  });
  const matTransparent = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    vertexColors: true,
  });
  const matEmissive = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: atlasTexture,
    emissiveIntensity: 0.25,
    vertexColors: true,
  });

  const group = new THREE.Group();
  group.name = "VoxelGroup";

  const geoOpaque = buildGeometry(opaque);
  const geoCutout = buildGeometry(cutout);
  const geoTransparent = buildGeometry(transparent);
  const geoEmissive = buildGeometry(emissive);

  if (geoOpaque) group.add(new THREE.Mesh(geoOpaque, matOpaque));
  if (geoCutout) group.add(new THREE.Mesh(geoCutout, matCutout));
  if (geoTransparent) group.add(new THREE.Mesh(geoTransparent, matTransparent));
  if (geoEmissive) group.add(new THREE.Mesh(geoEmissive, matEmissive));

  return {
    group,
    dispose: () => disposeObject(group),
    stats: { blockCount: blocks.length },
  };
}
