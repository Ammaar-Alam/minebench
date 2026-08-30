import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getVoxelExportMaterial } from "@/lib/voxel/export/materials";
import type { VoxelBuild } from "@/lib/voxel/types";

export type VoxelVoxExportStats = {
  width: number;
  height: number;
  length: number;
  volume: number;
  blockCount: number;
  paletteSize: number;
};

export type VoxelVoxExport = {
  bytes: Uint8Array;
  stats: VoxelVoxExportStats;
};

const VOX_VERSION = 150;
// MagicaVoxel refuses models larger than 256 on any axis
const MAX_VOX_DIMENSION = 256;
// palette slot 0 is reserved, leaving 255 usable color indices
const MAX_VOX_COLORS = 255;

function writeChunkHeader(view: DataView, offset: number, id: string, contentBytes: number, childrenBytes: number) {
  for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, id.charCodeAt(i));
  view.setUint32(offset + 4, contentBytes, true);
  view.setUint32(offset + 8, childrenBytes, true);
  return offset + 12;
}

function colorBytes(blockId: string): [number, number, number, number] {
  const factor = getVoxelExportMaterial(blockId).baseColorFactor;
  const toByte = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)));
  return [toByte(factor[0]), toByte(factor[1]), toByte(factor[2]), toByte(factor[3])];
}

export function buildVoxelVox(build: VoxelBuild, palette: BlockDefinition[]): VoxelVoxExport {
  const allowed = new Set(palette.map((block) => block.id));
  const blocksByPosition = new Map<string, { x: number; y: number; z: number; type: string }>();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const block of build.blocks) {
    if (!allowed.has(block.type)) continue;
    const key = `${block.x},${block.y},${block.z}`;
    blocksByPosition.set(key, block);
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    minZ = Math.min(minZ, block.z);
    maxX = Math.max(maxX, block.x);
    maxY = Math.max(maxY, block.y);
    maxZ = Math.max(maxZ, block.z);
  }

  const blocks = Array.from(blocksByPosition.values());
  if (blocks.length === 0) throw new Error("No blocks to export");

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const length = maxZ - minZ + 1;
  if (width > MAX_VOX_DIMENSION || height > MAX_VOX_DIMENSION || length > MAX_VOX_DIMENSION) {
    throw new Error(`MagicaVoxel export is limited to ${MAX_VOX_DIMENSION} blocks per axis`);
  }

  const blockTypeCounts = new Map<string, number>();
  for (const block of blocks) {
    blockTypeCounts.set(block.type, (blockTypeCounts.get(block.type) ?? 0) + 1);
  }

  const blockTypes = Array.from(blockTypeCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type]) => type);
  if (blockTypes.length > MAX_VOX_COLORS) {
    throw new Error(`MagicaVoxel export is limited to ${MAX_VOX_COLORS} block types`);
  }

  // color indices start at 1; slot 0 means empty
  const typeToColorIndex = new Map<string, number>();
  blockTypes.forEach((type, index) => typeToColorIndex.set(type, index + 1));

  const sizeContentBytes = 12;
  const xyziContentBytes = 4 + blocks.length * 4;
  const rgbaContentBytes = 256 * 4;
  const childrenBytes = 12 + sizeContentBytes + 12 + xyziContentBytes + 12 + rgbaContentBytes;
  const totalBytes = 8 + 12 + childrenBytes;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (let i = 0; i < 4; i += 1) view.setUint8(offset + i, "VOX ".charCodeAt(i));
  view.setUint32(offset + 4, VOX_VERSION, true);
  offset += 8;

  offset = writeChunkHeader(view, offset, "MAIN", 0, childrenBytes);

  // MagicaVoxel is z-up: SIZE is (x, depth, height) in MineBench terms
  offset = writeChunkHeader(view, offset, "SIZE", sizeContentBytes, 0);
  view.setUint32(offset, width, true);
  view.setUint32(offset + 4, length, true);
  view.setUint32(offset + 8, height, true);
  offset += sizeContentBytes;

  offset = writeChunkHeader(view, offset, "XYZI", xyziContentBytes, 0);
  view.setUint32(offset, blocks.length, true);
  offset += 4;
  for (const block of blocks) {
    // y-up right-handed to z-up right-handed: mirror the depth axis
    view.setUint8(offset, block.x - minX);
    view.setUint8(offset + 1, maxZ - block.z);
    view.setUint8(offset + 2, block.y - minY);
    view.setUint8(offset + 3, typeToColorIndex.get(block.type) ?? 0);
    offset += 4;
  }

  // palette color i lives at content offset (i - 1) * 4
  offset = writeChunkHeader(view, offset, "RGBA", rgbaContentBytes, 0);
  for (const type of blockTypes) {
    const colorIndex = typeToColorIndex.get(type) ?? 0;
    const [r, g, b, a] = colorBytes(type);
    const colorOffset = offset + (colorIndex - 1) * 4;
    view.setUint8(colorOffset, r);
    view.setUint8(colorOffset + 1, g);
    view.setUint8(colorOffset + 2, b);
    view.setUint8(colorOffset + 3, a);
  }

  return {
    bytes: out,
    stats: {
      width,
      height,
      length,
      volume: width * height * length,
      blockCount: blocks.length,
      paletteSize: blockTypes.length,
    },
  };
}
