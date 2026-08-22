import { getArenaPreviewTargetBlocks } from "@/lib/arena/buildArtifacts";
import { getArenaDeliveryPolicySignature } from "@/lib/arena/buildDeliveryPolicy";
import type { ArenaBuildVariant } from "@/lib/arena/types";
import { prisma } from "@/lib/prisma";
import { getBuildStorageBucketFromEnv } from "@/lib/storage/buildPayload";

export type ArenaArtifactStorageRef = { bucket: string; path: string };
export type ArenaSnapshotArtifactFormat = "json" | "binary";

const SNAPSHOT_PREFIX = normalizePrefix(
  process.env.ARENA_SNAPSHOT_ARTIFACT_PREFIX ?? "arena-snapshot/v2-gzip",
);
const snapshotPolicy = getArenaDeliveryPolicySignature();
const SNAPSHOT_POLICY_KEY = normalizePrefix(
  [
    "inline",
    snapshotPolicy.inlineMaxBytes,
    "snapshot",
    snapshotPolicy.snapshotMaxBytes,
    "artifact",
    snapshotPolicy.artifactMinBytes,
    "preview-trigger",
    snapshotPolicy.previewTriggerBytes,
    "preview-target",
    getArenaPreviewTargetBlocks(),
  ].join("-"),
);
const SNAPSHOT_BUCKET =
  process.env.ARENA_SNAPSHOT_ARTIFACT_BUCKET?.trim() || getBuildStorageBucketFromEnv();
const STREAM_PREFIX = normalizePrefix(
  process.env.ARENA_STREAM_ARTIFACT_PREFIX ?? "arena-stream/v3-gzip",
);
const STREAM_BUCKET =
  process.env.ARENA_STREAM_ARTIFACT_BUCKET?.trim() || getBuildStorageBucketFromEnv();

function normalizePrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

export function hasArenaSnapshotArtifactLocation(): boolean {
  return Boolean(SNAPSHOT_PREFIX && SNAPSHOT_POLICY_KEY && SNAPSHOT_BUCKET);
}

export function getArenaSnapshotArtifactRef(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  format: ArenaSnapshotArtifactFormat,
): ArenaArtifactStorageRef | null {
  const normalizedChecksum = checksum?.trim();
  if (!normalizedChecksum || !hasArenaSnapshotArtifactLocation()) return null;
  return {
    bucket: SNAPSHOT_BUCKET,
    path:
      `${SNAPSHOT_PREFIX}/${SNAPSHOT_POLICY_KEY}/${buildId}/` +
      `${variant}-${normalizedChecksum}${format === "binary" ? ".mbv4" : ".json"}`,
  };
}

export function getArenaStreamArtifactLocation(): {
  bucket: string;
  prefix: string;
} | null {
  if (!STREAM_PREFIX || !STREAM_BUCKET) return null;
  return { bucket: STREAM_BUCKET, prefix: STREAM_PREFIX };
}

export function getArenaCanonicalStreamArtifactRef(
  variant: ArenaBuildVariant,
  checksum: string | null,
): ArenaArtifactStorageRef | null {
  const location = getArenaStreamArtifactLocation();
  const normalizedChecksum = checksum?.trim();
  if (!location || !normalizedChecksum) return null;
  return {
    bucket: location.bucket,
    path: `${location.prefix}/checksum/${normalizedChecksum}/${variant}.ndjson`,
  };
}

export function getArenaLegacyStreamArtifactRef(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
): ArenaArtifactStorageRef | null {
  const location = getArenaStreamArtifactLocation();
  const normalizedChecksum = checksum?.trim();
  if (!location || !normalizedChecksum) return null;
  return {
    bucket: location.bucket,
    path: `${location.prefix}/${buildId}/${variant}-${normalizedChecksum}.ndjson`,
  };
}

function refKey(ref: ArenaArtifactStorageRef): string {
  return `${ref.bucket}:${ref.path}`;
}

export type ArenaRegisteredArtifactOwnership = {
  retiringRefs: ArenaArtifactStorageRef[];
  survivingRefKeys: ReadonlySet<string>;
};

export async function registerArenaBuildArtifact(
  buildId: string,
  ref: ArenaArtifactStorageRef,
): Promise<void> {
  await prisma.arenaBuildArtifact.upsert({
    where: { buildId_bucket_path: { buildId, bucket: ref.bucket, path: ref.path } },
    create: { buildId, bucket: ref.bucket, path: ref.path },
    update: {},
  });
}

async function loadRegisteredArtifactOwnership(
  retiringBuildIds: string[],
): Promise<ArenaRegisteredArtifactOwnership> {
  const retiring = await prisma.arenaBuildArtifact.findMany({
    where: { buildId: { in: retiringBuildIds } },
    select: { bucket: true, path: true },
  });
  const refs = Array.from(new Map(retiring.map((ref) => [refKey(ref), ref])).values());
  const surviving =
    refs.length === 0
      ? []
      : await prisma.arenaBuildArtifact.findMany({
          where: {
            buildId: { notIn: retiringBuildIds },
            OR: refs.map((ref) => ({ bucket: ref.bucket, path: ref.path })),
          },
          select: { bucket: true, path: true },
        });
  return {
    retiringRefs: refs,
    survivingRefKeys: new Set(surviving.map(refKey)),
  };
}

export async function deleteArenaBuildArtifacts(params: {
  retiringBuilds: ReadonlyArray<{ id: string; voxelSha256: string | null }>;
  survivingChecksums: ReadonlySet<string>;
  deleteStorage: (refs: ArenaArtifactStorageRef[]) => Promise<void>;
  registeredOwnership?: ArenaRegisteredArtifactOwnership;
}): Promise<{ deleted: number; preserved: number }> {
  const deleting = new Map<string, ArenaArtifactStorageRef>();
  const preserving = new Set<string>();
  const addDeleting = (ref: ArenaArtifactStorageRef | null) => {
    if (ref) deleting.set(refKey(ref), ref);
  };
  const registered =
    params.registeredOwnership ??
    (await loadRegisteredArtifactOwnership(params.retiringBuilds.map((build) => build.id)));
  for (const ref of registered.retiringRefs) addDeleting(ref);
  for (const key of registered.survivingRefKeys) preserving.add(key);

  for (const build of params.retiringBuilds) {
    const checksum = build.voxelSha256?.trim() || null;
    for (const variant of ["full", "preview"] as const) {
      addDeleting(getArenaSnapshotArtifactRef(build.id, variant, checksum, "json"));
      addDeleting(getArenaSnapshotArtifactRef(build.id, variant, checksum, "binary"));
      addDeleting(getArenaLegacyStreamArtifactRef(build.id, variant, checksum));
      const shared = getArenaCanonicalStreamArtifactRef(variant, checksum);
      if (!shared) continue;
      if (checksum && params.survivingChecksums.has(checksum)) {
        preserving.add(refKey(shared));
      } else {
        addDeleting(shared);
      }
    }
  }

  for (const key of preserving) deleting.delete(key);
  const refs = Array.from(deleting.values());
  if (refs.length > 0) await params.deleteStorage(refs);
  return { deleted: refs.length, preserved: preserving.size };
}
