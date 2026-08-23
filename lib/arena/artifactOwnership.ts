import { Prisma } from "@prisma/client";
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
const ARTIFACT_LOCK_TIMEOUT_MS = 5 * 60_000;

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

type ArenaArtifactBuildOwner = {
  model: {
    stealthVariant: {
      experiment: { status: string; retentionDeleteAt: Date | null };
    } | null;
  };
};

function isRetainedArtifactBuild(build: ArenaArtifactBuildOwner, now: Date): boolean {
  const experiment = build.model.stealthVariant?.experiment;
  return !(
    experiment?.status === "CLOSED" &&
    experiment.retentionDeleteAt &&
    experiment.retentionDeleteAt <= now
  );
}

async function lockArtifactRefs(
  tx: Prisma.TransactionClient,
  refs: ReadonlyArray<ArenaArtifactStorageRef>,
): Promise<void> {
  const keys = Array.from(new Set(refs.map(refKey))).sort();
  for (const key of keys) {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`arena-artifact:${key}`}, 0))
    `);
  }
}

const ARTIFACT_OWNER_SELECT = {
  buildId: true,
  bucket: true,
  path: true,
  build: {
    select: {
      model: {
        select: {
          stealthVariant: {
            select: {
              experiment: { select: { status: true, retentionDeleteAt: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ArenaBuildArtifactSelect;

async function compensateArtifactUpload(
  ref: ArenaArtifactStorageRef,
  deleteStorage: (refs: ArenaArtifactStorageRef[]) => Promise<void>,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await lockArtifactRefs(tx, [ref]);
      const owners = await tx.arenaBuildArtifact.findMany({
        where: { bucket: ref.bucket, path: ref.path },
        select: ARTIFACT_OWNER_SELECT,
      });
      if (!owners.some((owner) => isRetainedArtifactBuild(owner.build, new Date()))) {
        await deleteStorage([ref]);
      }
    },
    { maxWait: 10_000, timeout: ARTIFACT_LOCK_TIMEOUT_MS },
  );
}

export async function uploadArenaBuildArtifact(
  buildId: string,
  ref: ArenaArtifactStorageRef,
  upload: () => Promise<void>,
  deleteStorage: (refs: ArenaArtifactStorageRef[]) => Promise<void>,
): Promise<boolean> {
  let uploadAttempted = false;
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await lockArtifactRefs(tx, [ref]);
        let failure: unknown = null;
        try {
          await tx.arenaBuildArtifact.upsert({
            where: { buildId_bucket_path: { buildId, bucket: ref.bucket, path: ref.path } },
            create: { buildId, bucket: ref.bucket, path: ref.path },
            update: {},
          });
          uploadAttempted = true;
          await upload();
        } catch (error) {
          failure = error;
        }
        const owners = await tx.arenaBuildArtifact.findMany({
          where: { bucket: ref.bucket, path: ref.path },
          select: ARTIFACT_OWNER_SELECT,
        });
        const now = new Date();
        const accepted = owners.some(
          (owner) => owner.buildId === buildId && isRetainedArtifactBuild(owner.build, now),
        );
        if (!owners.some((owner) => isRetainedArtifactBuild(owner.build, now))) {
          try {
            await deleteStorage([ref]);
          } catch (error) {
            failure ??= error;
          }
        }
        return { accepted, failure };
      },
      { maxWait: 10_000, timeout: ARTIFACT_LOCK_TIMEOUT_MS },
    );
    if (outcome.failure) throw outcome.failure;
    return outcome.accepted;
  } catch (error) {
    if (uploadAttempted) await compensateArtifactUpload(ref, deleteStorage);
    throw error;
  }
}

async function loadRegisteredArtifactOwnership(
  retiringBuildIds: string[],
): Promise<ArenaRegisteredArtifactOwnership> {
  const retiring = await prisma.arenaBuildArtifact.findMany({
    where: { buildId: { in: retiringBuildIds } },
    select: { bucket: true, path: true },
  });
  const refs = Array.from(new Map(retiring.map((ref) => [refKey(ref), ref])).values());
  return {
    retiringRefs: refs,
    survivingRefKeys: new Set(),
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
  const canonicalChecksums = new Map<string, string>();
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
      if (params.registeredOwnership && checksum && params.survivingChecksums.has(checksum)) {
        preserving.add(refKey(shared));
      } else {
        addDeleting(shared);
        if (checksum) canonicalChecksums.set(refKey(shared), checksum);
      }
    }
  }

  if (params.registeredOwnership) {
    for (const key of preserving) deleting.delete(key);
    const refs = Array.from(deleting.values());
    if (refs.length > 0) await params.deleteStorage(refs);
    return { deleted: refs.length, preserved: preserving.size };
  }

  const candidates = Array.from(deleting.values());
  if (candidates.length === 0) return { deleted: 0, preserved: 0 };
  return prisma.$transaction(
    async (tx) => {
      await lockArtifactRefs(tx, candidates);
      const retiringBuildIds = new Set(params.retiringBuilds.map((build) => build.id));
      const owners = await tx.arenaBuildArtifact.findMany({
        where: { OR: candidates.map((ref) => ({ bucket: ref.bucket, path: ref.path })) },
        select: ARTIFACT_OWNER_SELECT,
      });
      const now = new Date();
      for (const owner of owners) {
        if (!retiringBuildIds.has(owner.buildId) && isRetainedArtifactBuild(owner.build, now)) {
          preserving.add(refKey(owner));
        }
      }

      const checksums = Array.from(new Set(canonicalChecksums.values()));
      if (checksums.length > 0) {
        const builds = await tx.build.findMany({
          where: {
            id: { notIn: Array.from(retiringBuildIds) },
            voxelSha256: { in: checksums },
          },
          select: {
            voxelSha256: true,
            model: {
              select: {
                stealthVariant: {
                  select: {
                    experiment: { select: { status: true, retentionDeleteAt: true } },
                  },
                },
              },
            },
          },
        });
        const retainedChecksums = new Set(
          builds
            .filter((build) => isRetainedArtifactBuild(build, now))
            .flatMap((build) => (build.voxelSha256 ? [build.voxelSha256] : [])),
        );
        for (const [key, checksum] of canonicalChecksums) {
          if (retainedChecksums.has(checksum)) preserving.add(key);
        }
      }

      const refs = candidates.filter((ref) => !preserving.has(refKey(ref)));
      if (refs.length > 0) await params.deleteStorage(refs);
      return { deleted: refs.length, preserved: preserving.size };
    },
    { maxWait: 10_000, timeout: ARTIFACT_LOCK_TIMEOUT_MS },
  );
}
