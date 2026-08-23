import assert from "node:assert/strict";
import {
  decodeBinaryArtifact,
  encodeBinaryArtifact,
  isBinaryArtifact,
  rewriteBlindBinaryArtifactIdentity,
} from "../../../lib/arena/binaryArtifact";
import {
  BinaryBuildFormatError,
  readBinaryVoxelBuildHeader,
} from "../../../lib/voxel/binaryBuild";
import { unpackVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import type { VoxelBlock } from "../../../lib/voxel/types";

const blocks: VoxelBlock[] = Array.from({ length: 1200 }, (_, i) => ({
  x: i % 200,
  y: (i * 3) % 200,
  z: (i * 11) % 200,
  type: ["stone", "water", "glass"][i % 3],
}));

const envelope = {
  buildId: "cms28u1m20003jp045untyi3l",
  variant: "full",
  checksum: "8e657650a1b2c3d4",
  serverValidated: true,
  buildLoadHints: { deliveryClass: "snapshot", fullBlockCount: blocks.length },
};

async function main() {
  {
    const encoded = encodeBinaryArtifact(envelope, blocks, "deadbeef" + "0".repeat(56));
    assert.ok(isBinaryArtifact(encoded));

    const decoded = decodeBinaryArtifact(encoded);
    assert.deepEqual(decoded.envelope, envelope);
    assert.equal(decoded.blocks.count, blocks.length);
    assert.deepEqual(unpackVoxelBlocks(decoded.blocks), blocks);
  }

  {
    const encoded = encodeBinaryArtifact(envelope, blocks, "deadbeef" + "0".repeat(56));
    const blinded = rewriteBlindBinaryArtifactIdentity(encoded, "b1.blind-build");
    const decoded = decodeBinaryArtifact(blinded);
    const envelopeBytes = new DataView(
      blinded.buffer,
      blinded.byteOffset,
      blinded.byteLength,
    ).getUint32(4, false);

    assert.deepEqual(decoded.envelope, {
      ...envelope,
      buildId: "b1.blind-build",
      checksum: null,
    });
    assert.deepEqual(unpackVoxelBlocks(decoded.blocks), blocks);
    assert.equal(readBinaryVoxelBuildHeader(blinded.subarray(8 + envelopeBytes)).checksumPrefix, 0);
  }

  {
    // the container must not be mistaken for the gzip JSON artifact beside it
    assert.equal(isBinaryArtifact(new TextEncoder().encode('{"buildId":"x"}')), false);
    assert.equal(isBinaryArtifact(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])), false);
  }

  {
    const encoded = encodeBinaryArtifact(envelope, blocks);

    assert.throws(
      () => decodeBinaryArtifact(encoded.slice(0, 4)),
      (err: unknown) => err instanceof BinaryBuildFormatError,
      "truncated header",
    );

    const overstated = encoded.slice();
    new DataView(overstated.buffer).setUint32(4, 0xfffff, false);
    assert.throws(
      () => decodeBinaryArtifact(overstated),
      (err: unknown) => err instanceof BinaryBuildFormatError,
      "envelope length past the end",
    );

    // a view into a larger buffer decodes from its own offset
    const padded = new Uint8Array(encoded.length + 5);
    padded.set(encoded, 5);
    assert.equal(decodeBinaryArtifact(padded.subarray(5)).blocks.count, blocks.length);
  }

  console.log("binary artifact container checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
