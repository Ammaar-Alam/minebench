import {
  decodeBinaryVoxelBuild,
  encodeBinaryVoxelBuild,
  BinaryBuildFormatError,
} from "@/lib/voxel/binaryBuild";
import type { PackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import type { VoxelBlock } from "@/lib/voxel/types";

// A snapshot artifact carries delivery metadata alongside the blocks, and the
// client needs both. The metadata stays JSON because it is small and read
// once; only the blocks move to the binary encoding, where the size and decode
// wins actually are.
//
//   offset  size  field
//   0       4     magic "MBA4"
//   4       4     envelope JSON byte length E (big-endian)
//   8       E     envelope JSON (everything but the blocks)
//   8+E     ...   binary v4 block payload
//
// The whole container is gzipped for storage and transfer, the same as the
// JSON artifact it sits beside.

export const BINARY_ARTIFACT_MAGIC = 0x4d424134;
const BINARY_ARTIFACT_HEADER_BYTES = 8;
const MAX_ENVELOPE_BYTES = 1_048_576;

export type BinaryArtifactEnvelope = Record<string, unknown>;

export type DecodedBinaryArtifact = {
  envelope: BinaryArtifactEnvelope;
  blocks: PackedVoxelBlocks;
};

export function isBinaryArtifact(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_ARTIFACT_HEADER_BYTES) return false;
  return bytes[0] === 0x4d && bytes[1] === 0x42 && bytes[2] === 0x41 && bytes[3] === 0x34;
}

export function encodeBinaryArtifact(
  envelope: BinaryArtifactEnvelope,
  blocks: readonly VoxelBlock[] | PackedVoxelBlocks,
  sha256Hex?: string | null,
): Uint8Array {
  const envelopeJson = new TextEncoder().encode(JSON.stringify(envelope));
  if (envelopeJson.length > MAX_ENVELOPE_BYTES) {
    throw new BinaryBuildFormatError(
      `Artifact envelope of ${envelopeJson.length} bytes exceeds the container limit`,
    );
  }
  const body = encodeBinaryVoxelBuild(blocks, sha256Hex);

  const bytes = new Uint8Array(BINARY_ARTIFACT_HEADER_BYTES + envelopeJson.length + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, BINARY_ARTIFACT_MAGIC, false);
  view.setUint32(4, envelopeJson.length, false);
  bytes.set(envelopeJson, BINARY_ARTIFACT_HEADER_BYTES);
  bytes.set(body, BINARY_ARTIFACT_HEADER_BYTES + envelopeJson.length);
  return bytes;
}

export function decodeBinaryArtifact(bytes: Uint8Array): DecodedBinaryArtifact {
  if (!isBinaryArtifact(bytes)) {
    throw new BinaryBuildFormatError("Not a binary arena build artifact");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const envelopeBytes = view.getUint32(4, false);
  if (
    envelopeBytes > MAX_ENVELOPE_BYTES ||
    BINARY_ARTIFACT_HEADER_BYTES + envelopeBytes > bytes.byteLength
  ) {
    throw new BinaryBuildFormatError(`Artifact envelope length ${envelopeBytes} is out of range`);
  }

  const envelopeText = new TextDecoder().decode(
    bytes.subarray(BINARY_ARTIFACT_HEADER_BYTES, BINARY_ARTIFACT_HEADER_BYTES + envelopeBytes),
  );
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new BinaryBuildFormatError("Artifact envelope is not valid JSON");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new BinaryBuildFormatError("Artifact envelope is not an object");
  }

  const blocks = decodeBinaryVoxelBuild(
    bytes.subarray(BINARY_ARTIFACT_HEADER_BYTES + envelopeBytes),
  );
  return { envelope: envelope as BinaryArtifactEnvelope, blocks };
}
