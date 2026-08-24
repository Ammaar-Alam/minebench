import { getRenderKind } from "@/lib/blocks/registry";
import {
  computeFaceAO,
  computeVisibleFaceMask,
  DIRS,
  SpatialBlockTable,
} from "@/lib/voxel/ambientOcclusion";
import {
  decodeBinaryVoxelBuild,
  encodeBinaryVoxelBuild,
  readBinaryVoxelBuildHeader,
} from "@/lib/voxel/binaryBuild";
import {
  copyPackedVoxelBlocks,
  type PackedVoxelBlocks,
} from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";

export const MESH_FACTS_MAGIC = 0x4d424631;
export const MESH_FACTS_VERSION = 1;
export const MESH_FACTS_HEADER_BYTES = 24;

const MAX_UINT32 = 0xffff_ffff;
const WATER_BLOCK_ID = "water";
const FACE_COUNT_BY_MASK = new Uint8Array(64);
for (let mask = 0; mask < FACE_COUNT_BY_MASK.length; mask += 1) {
  let value = mask;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  FACE_COUNT_BY_MASK[mask] = count;
}

export type VoxelMeshFacts = {
  blocks: PackedVoxelBlocks;
  visibilityMasks: Uint8Array;
  ambientOcclusion: Uint8Array;
  visibleFaceCount: number;
  filteredBlockCount: number;
};

export type VoxelMeshFactsHeader = {
  version: number;
  flags: number;
  blockPayloadBytes: number;
  visibleFaceCount: number;
  ambientOcclusionFaceCount: number;
  filteredBlockCount: number;
};

export class VoxelMeshFactsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoxelMeshFactsFormatError";
  }
}

function faceCount(mask: number): number {
  return FACE_COUNT_BY_MASK[mask & 0x3f];
}

function encodeAmbientOcclusion(
  factors: readonly [number, number, number, number],
): number {
  let packed = 0;
  for (let i = 0; i < 4; i += 1) {
    const level = Math.max(0, Math.min(3, Math.round(((factors[i] - 0.58) / 0.42) * 3)));
    packed |= level << (i * 2);
  }
  return packed;
}

function validatePackedBlocks(blocks: PackedVoxelBlocks): void {
  if (!Number.isInteger(blocks.count) || blocks.count < 0) {
    throw new VoxelMeshFactsFormatError("Mesh facts block count is invalid");
  }
  if (blocks.positions.length < blocks.count * 3 || blocks.typeIds.length < blocks.count) {
    throw new VoxelMeshFactsFormatError("Mesh facts block arrays are truncated");
  }
  for (let i = 0; i < blocks.count; i += 1) {
    if (blocks.typeIds[i] >= blocks.typeNames.length) {
      throw new VoxelMeshFactsFormatError(
        `Block ${i} references palette entry ${blocks.typeIds[i]}`,
      );
    }
  }
}

export function createVoxelMeshFacts(blocks: PackedVoxelBlocks): VoxelMeshFacts {
  validatePackedBlocks(blocks);
  const table = new SpatialBlockTable(blocks.count);
  const materialOccluding = new Uint8Array(blocks.typeNames.length);
  for (let typeId = 0; typeId < blocks.typeNames.length; typeId += 1) {
    materialOccluding[typeId] = isVoxelOccluder(blocks.typeNames[typeId]) ? 1 : 0;
  }

  for (let i = 0; i < blocks.count; i += 1) {
    table.set(
      blocks.positions[i * 3],
      blocks.positions[i * 3 + 1],
      blocks.positions[i * 3 + 2],
      blocks.typeIds[i],
    );
  }

  const visibilityMasks = new Uint8Array(blocks.count);
  let visibleFaceCount = 0;
  let filteredBlockCount = 0;
  for (let i = 0; i < blocks.count; i += 1) {
    const mask = computeVisibleFaceMask(
      blocks.positions[i * 3],
      blocks.positions[i * 3 + 1],
      blocks.positions[i * 3 + 2],
      blocks.typeIds[i],
      table,
      materialOccluding,
    );
    visibilityMasks[i] = mask;
    if (mask !== 0) filteredBlockCount += 1;
    visibleFaceCount += faceCount(mask);
  }

  const ambientOcclusion = new Uint8Array(visibleFaceCount);
  let ambientOcclusionFaceCount = 0;
  for (let i = 0; i < blocks.count; i += 1) {
    const mask = visibilityMasks[i];
    if (mask === 0) continue;
    const type = blocks.typeNames[blocks.typeIds[i]];
    if (type === WATER_BLOCK_ID || getRenderKind(type) === "emissive") continue;
    const x = blocks.positions[i * 3];
    const y = blocks.positions[i * 3 + 1];
    const z = blocks.positions[i * 3 + 2];
    for (let dIdx = 0; dIdx < DIRS.length; dIdx += 1) {
      if ((mask & (1 << dIdx)) === 0) continue;
      ambientOcclusion[ambientOcclusionFaceCount] = encodeAmbientOcclusion(
        computeFaceAO(DIRS[dIdx], x, y, z, table, materialOccluding),
      );
      ambientOcclusionFaceCount += 1;
    }
  }

  return {
    blocks,
    visibilityMasks,
    ambientOcclusion: ambientOcclusion.slice(0, ambientOcclusionFaceCount),
    visibleFaceCount,
    filteredBlockCount,
  };
}

export function encodeVoxelMeshFacts(facts: VoxelMeshFacts): Uint8Array {
  validatePackedBlocks(facts.blocks);
  if (facts.visibilityMasks.length !== facts.blocks.count) {
    throw new VoxelMeshFactsFormatError("Mesh facts visibility masks do not match block count");
  }
  const blockPayload = encodeBinaryVoxelBuild(facts.blocks, null);
  const fields = [
    blockPayload.byteLength,
    facts.visibleFaceCount,
    facts.ambientOcclusion.byteLength,
    facts.filteredBlockCount,
  ];
  if (fields.some((value) => !Number.isInteger(value) || value < 0 || value > MAX_UINT32)) {
    throw new VoxelMeshFactsFormatError("Mesh facts header value exceeds its field");
  }
  const total = MESH_FACTS_HEADER_BYTES + blockPayload.byteLength +
    facts.visibilityMasks.byteLength + facts.ambientOcclusion.byteLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MESH_FACTS_MAGIC, false);
  view.setUint8(4, MESH_FACTS_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, MESH_FACTS_HEADER_BYTES, false);
  view.setUint32(8, blockPayload.byteLength, false);
  view.setUint32(12, facts.visibleFaceCount, false);
  view.setUint32(16, facts.ambientOcclusion.byteLength, false);
  view.setUint32(20, facts.filteredBlockCount, false);
  bytes.set(blockPayload, MESH_FACTS_HEADER_BYTES);
  bytes.set(facts.visibilityMasks, MESH_FACTS_HEADER_BYTES + blockPayload.byteLength);
  bytes.set(
    facts.ambientOcclusion,
    MESH_FACTS_HEADER_BYTES + blockPayload.byteLength + facts.visibilityMasks.byteLength,
  );
  return bytes;
}

export function isVoxelMeshFacts(bytes: Uint8Array): boolean {
  return bytes.length >= MESH_FACTS_HEADER_BYTES &&
    bytes[0] === 0x4d && bytes[1] === 0x42 && bytes[2] === 0x46 && bytes[3] === 0x31;
}

export function readVoxelMeshFactsHeader(bytes: Uint8Array): VoxelMeshFactsHeader {
  if (!isVoxelMeshFacts(bytes)) {
    throw new VoxelMeshFactsFormatError("Not an MBF1 mesh facts payload");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== MESH_FACTS_VERSION) {
    throw new VoxelMeshFactsFormatError(`Unsupported mesh facts version ${version}`);
  }
  const headerBytes = view.getUint16(6, false);
  if (headerBytes !== MESH_FACTS_HEADER_BYTES) {
    throw new VoxelMeshFactsFormatError(`Unsupported mesh facts header length ${headerBytes}`);
  }
  return {
    version,
    flags: view.getUint8(5),
    blockPayloadBytes: view.getUint32(8, false),
    visibleFaceCount: view.getUint32(12, false),
    ambientOcclusionFaceCount: view.getUint32(16, false),
    filteredBlockCount: view.getUint32(20, false),
  };
}

export function decodeVoxelMeshFacts(bytes: Uint8Array): VoxelMeshFacts {
  const header = readVoxelMeshFactsHeader(bytes);
  const blockPayloadEnd = MESH_FACTS_HEADER_BYTES + header.blockPayloadBytes;
  if (blockPayloadEnd > bytes.byteLength) {
    throw new VoxelMeshFactsFormatError("Mesh facts block payload is truncated");
  }
  const blockPayload = bytes.subarray(MESH_FACTS_HEADER_BYTES, blockPayloadEnd);
  let nestedHeader;
  try {
    nestedHeader = readBinaryVoxelBuildHeader(blockPayload);
  } catch (error) {
    throw new VoxelMeshFactsFormatError(
      error instanceof Error ? error.message : "Mesh facts block payload is invalid",
    );
  }
  if (nestedHeader.checksumPrefix !== 0) {
    throw new VoxelMeshFactsFormatError("Mesh facts block payload contains a content identity");
  }
  const expectedLength = blockPayloadEnd + nestedHeader.blockCount +
    header.ambientOcclusionFaceCount;
  if (bytes.byteLength !== expectedLength) {
    throw new VoxelMeshFactsFormatError(
      `Mesh facts length ${bytes.byteLength} does not match the declared ${expectedLength}`,
    );
  }

  const blocks = decodeBinaryVoxelBuild(blockPayload);
  const visibilityMasks = bytes.slice(blockPayloadEnd, blockPayloadEnd + blocks.count);
  const ambientOcclusion = bytes.slice(blockPayloadEnd + blocks.count);
  let visibleFaceCount = 0;
  let filteredBlockCount = 0;
  let ambientOcclusionFaceCount = 0;
  for (let i = 0; i < blocks.count; i += 1) {
    const mask = visibilityMasks[i];
    if ((mask & 0xc0) !== 0) {
      throw new VoxelMeshFactsFormatError(`Block ${i} has an invalid visibility mask`);
    }
    if (mask !== 0) filteredBlockCount += 1;
    const faces = faceCount(mask);
    visibleFaceCount += faces;
    const type = blocks.typeNames[blocks.typeIds[i]];
    if (type !== WATER_BLOCK_ID && getRenderKind(type) !== "emissive") {
      ambientOcclusionFaceCount += faces;
    }
  }
  if (visibleFaceCount !== header.visibleFaceCount) {
    throw new VoxelMeshFactsFormatError("Mesh facts visible face count is inconsistent");
  }
  if (filteredBlockCount !== header.filteredBlockCount) {
    throw new VoxelMeshFactsFormatError("Mesh facts filtered block count is inconsistent");
  }
  if (ambientOcclusionFaceCount !== header.ambientOcclusionFaceCount) {
    throw new VoxelMeshFactsFormatError("Mesh facts ambient occlusion count is inconsistent");
  }

  return {
    blocks,
    visibilityMasks,
    ambientOcclusion,
    visibleFaceCount,
    filteredBlockCount,
  };
}

export function copyVoxelMeshFacts(facts: VoxelMeshFacts): VoxelMeshFacts {
  return {
    blocks: copyPackedVoxelBlocks(facts.blocks),
    visibilityMasks: facts.visibilityMasks.slice(),
    ambientOcclusion: facts.ambientOcclusion.slice(),
    visibleFaceCount: facts.visibleFaceCount,
    filteredBlockCount: facts.filteredBlockCount,
  };
}
