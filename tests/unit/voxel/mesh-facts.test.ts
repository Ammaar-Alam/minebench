import assert from "node:assert/strict";
import {
  decodeVoxelMeshFacts,
  encodeVoxelMeshFacts,
  isVoxelMeshFacts,
  MESH_FACTS_HEADER_BYTES,
  readVoxelMeshFactsHeader,
  createVoxelMeshFacts,
  VoxelMeshFactsFormatError,
} from "../../../lib/voxel/meshFacts";
import { readBinaryVoxelBuildHeader } from "../../../lib/voxel/binaryBuild";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";

const packed = packVoxelBlocks([
  { x: 0, y: 0, z: 0, type: "stone" },
  { x: 1, y: 0, z: 0, type: "stone" },
  { x: 0, y: 1, z: 0, type: "grass_block" },
  { x: 1, y: 1, z: 0, type: "glass" },
  { x: 2, y: 0, z: 0, type: "water" },
  { x: 3, y: 0, z: 0, type: "glowstone" },
]);

const facts = createVoxelMeshFacts(packed);
const encoded = encodeVoxelMeshFacts(facts);
assert.equal(isVoxelMeshFacts(encoded), true);

const header = readVoxelMeshFactsHeader(encoded);
assert.equal(header.filteredBlockCount, facts.filteredBlockCount);
assert.equal(header.visibleFaceCount, facts.visibleFaceCount);
assert.equal(header.ambientOcclusionFaceCount, facts.ambientOcclusion.length);

const nested = encoded.subarray(
  MESH_FACTS_HEADER_BYTES,
  MESH_FACTS_HEADER_BYTES + header.blockPayloadBytes,
);
assert.equal(readBinaryVoxelBuildHeader(nested).checksumPrefix, 0);

const decoded = decodeVoxelMeshFacts(encoded);
assert.deepEqual(decoded.blocks.typeNames, facts.blocks.typeNames);
assert.deepEqual(decoded.blocks.positions, facts.blocks.positions);
assert.deepEqual(decoded.blocks.typeIds, facts.blocks.typeIds);
assert.deepEqual(decoded.visibilityMasks, facts.visibilityMasks);
assert.deepEqual(decoded.ambientOcclusion, facts.ambientOcclusion);
assert.equal(decoded.visibleFaceCount, facts.visibleFaceCount);
assert.equal(decoded.filteredBlockCount, facts.filteredBlockCount);

assert.throws(
  () => decodeVoxelMeshFacts(encoded.subarray(0, encoded.length - 1)),
  VoxelMeshFactsFormatError,
);

const invalidMask = encoded.slice();
invalidMask[MESH_FACTS_HEADER_BYTES + header.blockPayloadBytes] = 0x80;
assert.throws(() => decodeVoxelMeshFacts(invalidMask), /invalid visibility mask/);

console.log("mesh facts codec unit tests passed");
