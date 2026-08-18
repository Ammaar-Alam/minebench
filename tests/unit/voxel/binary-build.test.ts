import assert from "node:assert/strict";
import {
  BINARY_BUILD_HEADER_BYTES,
  BinaryBuildFormatError,
  decodeBinaryVoxelBuild,
  encodeBinaryVoxelBuild,
  isBinaryVoxelBuild,
  readBinaryVoxelBuildHeader,
} from "../../../lib/voxel/binaryBuild";
import { unpackVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import type { VoxelBlock } from "../../../lib/voxel/types";

const TYPES = ["stone", "oak_planks", "glass", "water", "oak_leaves", "gold_block"];

function makeBlocks(count: number): VoxelBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    x: (i * 7) % 256,
    y: (i * 13) % 256,
    z: (i * 29) % 256,
    type: TYPES[i % TYPES.length],
  }));
}

function expectFormatError(run: () => unknown, label: string) {
  assert.throws(run, (err: unknown) => err instanceof BinaryBuildFormatError, label);
}

async function main() {
  {
    const blocks = makeBlocks(5000);
    const encoded = encodeBinaryVoxelBuild(blocks, "a1b2c3d4" + "0".repeat(56));
    assert.ok(isBinaryVoxelBuild(encoded));

    const header = readBinaryVoxelBuildHeader(encoded);
    assert.equal(header.version, 4);
    assert.equal(header.blockCount, blocks.length);
    assert.equal(header.checksumPrefix, 0xa1b2c3d4);
    assert.equal(
      encoded.byteLength,
      BINARY_BUILD_HEADER_BYTES + header.paletteBytes + blocks.length * 8,
    );

    const decoded = decodeBinaryVoxelBuild(encoded);
    assert.equal(decoded.count, blocks.length);
    assert.deepEqual(unpackVoxelBlocks(decoded), blocks);
  }

  {
    // grid edges and the empty build both have to survive the round trip
    const edges: VoxelBlock[] = [
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 511, y: 511, z: 511, type: "water" },
      { x: 1023, y: 0, z: 1023, type: "stone" },
    ];
    assert.deepEqual(unpackVoxelBlocks(decodeBinaryVoxelBuild(encodeBinaryVoxelBuild(edges))), edges);

    const empty = encodeBinaryVoxelBuild([]);
    assert.equal(readBinaryVoxelBuildHeader(empty).blockCount, 0);
    assert.deepEqual(unpackVoxelBlocks(decodeBinaryVoxelBuild(empty)), []);
  }

  {
    // a coordinate outside the grid must fail loudly rather than wrap silently
    expectFormatError(
      () => encodeBinaryVoxelBuild([{ x: 1024, y: 0, z: 0, type: "stone" }]),
      "coordinate above the grid",
    );
    expectFormatError(
      () => encodeBinaryVoxelBuild([{ x: -1, y: 0, z: 0, type: "stone" }]),
      "negative coordinate",
    );
  }

  {
    // malformed payloads are rejected before anything is allocated from them
    const encoded = encodeBinaryVoxelBuild(makeBlocks(64));

    expectFormatError(() => readBinaryVoxelBuildHeader(new Uint8Array(4)), "too short");
    expectFormatError(
      () => readBinaryVoxelBuildHeader(new Uint8Array(BINARY_BUILD_HEADER_BYTES)),
      "wrong magic",
    );

    const badVersion = encoded.slice();
    badVersion[4] = 5;
    expectFormatError(() => readBinaryVoxelBuildHeader(badVersion), "unsupported version");

    const truncated = encoded.slice(0, encoded.length - 8);
    expectFormatError(() => readBinaryVoxelBuildHeader(truncated), "declared length mismatch");

    const overstated = encoded.slice();
    new DataView(overstated.buffer).setUint32(8, 0xffffff, false);
    expectFormatError(() => readBinaryVoxelBuildHeader(overstated), "block count overstated");

    // a type id past the end of the palette must not read past the array
    const badTypeId = encoded.slice();
    const header = readBinaryVoxelBuildHeader(encoded);
    const typeIdsAt = BINARY_BUILD_HEADER_BYTES + header.paletteBytes + header.blockCount * 6;
    new DataView(badTypeId.buffer).setUint16(typeIdsAt, 9999, true);
    expectFormatError(() => decodeBinaryVoxelBuild(badTypeId), "type id past the palette");
  }

  {
    // a view into a larger buffer must decode from its own offset
    const encoded = encodeBinaryVoxelBuild(makeBlocks(256));
    const padded = new Uint8Array(encoded.length + 3);
    padded.set(encoded, 3);
    const view = padded.subarray(3);
    assert.equal(decodeBinaryVoxelBuild(view).count, 256);
  }

  console.log("binary build format checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
