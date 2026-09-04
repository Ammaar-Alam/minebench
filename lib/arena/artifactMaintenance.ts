import type { ArenaBuildSource, PreparedArenaBuild } from "@/lib/arena/buildArtifacts";
import {
  getPreparedArenaBuildCoreMetadataUpdate,
  pickBuildVariant,
  prepareArenaBuild,
} from "@/lib/arena/buildArtifacts";
import { estimateArenaBuildBytes, isArtifactEligibleBuild } from "@/lib/arena/buildDeliveryPolicy";
import type { ArenaBuildStreamEvent } from "@/lib/arena/types";
import {
  encodeArenaBuildStreamEvent,
  iterateArenaBuildStreamEvents,
  uploadArenaBuildStreamArtifact,
} from "@/lib/arena/buildStream";
import { ensureArenaBuildSnapshotArtifacts } from "@/lib/arena/buildSnapshotArtifacts";
import { invalidateArenaBuildMeta } from "@/lib/arena/buildMetaCache";
import { prisma } from "@/lib/prisma";

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
    blockCount: source.blockCount,
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
  return maybePrecomputeArenaStreamArtifactsForPrepared(prepared);
}

export async function maybePrecomputeArenaArtifactsForBuild(
  source: ArenaBuildSource,
): Promise<{ streamUploaded: number; snapshotUploaded: boolean; streamSkipped: boolean; reason?: string }> {
  const prepared = await prepareArenaBuild(source);
  return maybePrecomputeArenaArtifactsForPreparedBuild(prepared, resolveSourceBytes(source));
}

export async function maybePrecomputeArenaArtifactsForPreparedBuild(
  prepared: PreparedArenaBuild,
  estimatedBytes: number | null,
): Promise<{ streamUploaded: number; snapshotUploaded: boolean; streamSkipped: boolean; reason?: string }> {
  const marked = await prisma.build.updateMany({
    where: prepared.payloadIdentity,
    data: getPreparedArenaBuildCoreMetadataUpdate(prepared),
  });
  if (marked.count === 0) {
    throw new Error(`Build ${prepared.buildId} changed during artifact preparation`);
  }
  invalidateArenaBuildMeta(prepared.buildId);
  const stream = isArtifactEligibleBuild(estimatedBytes)
    ? await maybePrecomputeArenaStreamArtifactsForPrepared(prepared)
    : { uploaded: 0, skipped: true, reason: "below_threshold" as const };

  await ensureArenaBuildSnapshotArtifacts(prepared);
  return {
    streamUploaded: stream.uploaded,
    snapshotUploaded: true,
    streamSkipped: stream.skipped,
    reason: stream.reason,
  };
}

async function maybePrecomputeArenaStreamArtifactsForPrepared(
  prepared: Awaited<ReturnType<typeof prepareArenaBuild>>,
): Promise<{ uploaded: number; skipped: boolean; reason?: string }> {
  if (!prepared.checksum) {
    return { uploaded: 0, skipped: true, reason: "missing_checksum" };
  }

  let uploaded = 0;
  for (const variant of ["full", "preview"] as const) {
    const variantBuild = pickBuildVariant(prepared, variant);
    const bytes = chunkBytes(
      iterateArenaBuildStreamEvents({
        buildId: prepared.buildId,
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
    await uploadArenaBuildStreamArtifact(prepared.buildId, variant, prepared.checksum, bytes);
    uploaded += 1;
  }

  return { uploaded, skipped: false };
}
