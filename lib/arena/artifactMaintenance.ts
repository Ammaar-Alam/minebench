import type { ArenaBuildSource } from "@/lib/arena/buildArtifacts";
import { pickBuildVariant, prepareArenaBuild } from "@/lib/arena/buildArtifacts";
import { estimateArenaBuildBytes, isArtifactEligibleBuild } from "@/lib/arena/buildDeliveryPolicy";
import type { ArenaBuildStreamEvent } from "@/lib/arena/types";
import {
  encodeArenaBuildStreamEvent,
  iterateArenaBuildStreamEvents,
  uploadArenaBuildStreamArtifact,
} from "@/lib/arena/buildStream";

function chunkBytes(events: Iterable<ArenaBuildStreamEvent>) {
  const encoded: Uint8Array[] = [];
  let total = 0;
  for (const event of events) {
    const bytes = encodeArenaBuildStreamEvent(event);
    encoded.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function resolveSourceBytes(source: ArenaBuildSource): number | null {
  const fromMetadata = estimateArenaBuildBytes({
    voxelByteSize: source.voxelByteSize,
    voxelCompressedByteSize: source.voxelCompressedByteSize,
  });
  if (fromMetadata != null) return fromMetadata;
  if (source.voxelData) {
    try {
      return Buffer.byteLength(JSON.stringify(source.voxelData));
    } catch {
      return null;
    }
  }
  return null;
}

export async function maybePrecomputeArenaStreamArtifactsForBuild(
  source: ArenaBuildSource,
): Promise<{ uploaded: number; skipped: boolean; reason?: string }> {
  const estimatedBytes = resolveSourceBytes(source);
  if (!isArtifactEligibleBuild(estimatedBytes)) {
    return { uploaded: 0, skipped: true, reason: "below_threshold" };
  }

  const prepared = await prepareArenaBuild(source);
  if (!prepared.checksum) {
    return { uploaded: 0, skipped: true, reason: "missing_checksum" };
  }

  let uploaded = 0;
  for (const variant of ["full", "preview"] as const) {
    const variantBuild = pickBuildVariant(prepared, variant);
    const bytes = chunkBytes(
      iterateArenaBuildStreamEvents({
        buildId: source.id,
        variant,
        checksum: prepared.checksum,
        build: variantBuild,
        buildLoadHints: prepared.hints,
        source: "artifact",
        serverValidated: true,
        includePad: true,
        durationMs: 0,
      }),
    );
    await uploadArenaBuildStreamArtifact(source.id, variant, prepared.checksum, bytes);
    uploaded += 1;
  }

  return { uploaded, skipped: false };
}

