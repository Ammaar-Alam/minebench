import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  classifyArenaBuildDelivery,
  estimateArenaBuildBytes,
  getArenaArtifactMinBytes,
} from "@/lib/arena/buildDeliveryPolicy";
import { parsePersistedArenaBuildMetadata } from "@/lib/arena/buildArtifacts";
import {
  getSnapshotArtifactRef,
  isBinarySnapshotArtifactEnabled,
} from "@/lib/arena/buildSnapshotArtifacts";
import { getArenaBuildStreamArtifactFetchRefs } from "@/lib/arena/buildStream";
import { arenaCohortBuildWhere } from "@/lib/arena/eligibility";

// Policy-derived artifact expectations per build, shared by the precompute
// scripts (--missing-only), the admin status route, and publish verification.
// Requirements come from the delivery policy, never from a fixed count: full
// snapshots exist only for inline/snapshot classes, preview snapshots only
// where persisted load hints record a smaller preview, and stream artifacts
// only for builds at or above the artifact byte threshold.

export type ArtifactRef = { bucket: string; path: string };

// A requirement is satisfied when any one of its refs exists, since stream
// artifacts have preferred and legacy storage locations
export type ArtifactRequirement = {
  kind: "snapshot" | "snapshot-binary" | "stream";
  variant: "full" | "preview";
  refs: ArtifactRef[];
};

export type ArenaBuildArtifactStatusRow = {
  id: string;
  blockCount: number | null;
  voxelByteSize: number | null;
  voxelCompressedByteSize: number | null;
  voxelSha256: string | null;
  arenaBuildHints: unknown;
};

export const ARTIFACT_STATUS_BUILD_SELECT = {
  id: true,
  blockCount: true,
  voxelByteSize: true,
  voxelCompressedByteSize: true,
  voxelSha256: true,
  arenaBuildHints: true,
} as const;

export type ArenaBuildArtifactStatus = {
  buildId: string;
  // valid voxelSha256 and load hints are required metadata
  missingCoreMetadata: boolean;
  // snapshot-class build whose artifact refs cannot be derived yet
  needsSnapshotCompute: boolean;
  required: ArtifactRequirement[];
  missing: ArtifactRequirement[];
};

function refKey(ref: ArtifactRef): string {
  return `${ref.bucket}/${ref.path}`;
}

// Returns the set of refKey() strings that exist in storage
export async function probeStorageObjects(refs: readonly ArtifactRef[]): Promise<Set<string>> {
  const pathsByBucket = new Map<string, Set<string>>();
  for (const ref of refs) {
    const bucketPaths = pathsByBucket.get(ref.bucket) ?? new Set<string>();
    bucketPaths.add(ref.path);
    pathsByBucket.set(ref.bucket, bucketPaths);
  }

  const existing = new Set<string>();
  for (const [bucket, paths] of pathsByBucket.entries()) {
    const uniquePaths = Array.from(paths);
    if (uniquePaths.length === 0) continue;
    const rows = await prisma.$queryRaw<{ name: string }[]>(
      Prisma.sql`
        SELECT name
        FROM storage.objects
        WHERE bucket_id = ${bucket}
          AND name IN (${Prisma.join(uniquePaths)})
      `,
    );
    for (const row of rows) {
      if (row.name) existing.add(`${bucket}/${row.name}`);
    }
  }
  return existing;
}

// Computes the determinable artifact requirements for one build row
export function expectedArtifactRequirements(
  row: ArenaBuildArtifactStatusRow,
  // callers with their own --min-bytes must discover work against that same
  // threshold, or builds between it and the env default are never selected
  streamMinBytes?: number,
): {
  missingCoreMetadata: boolean;
  needsSnapshotCompute: boolean;
  required: ArtifactRequirement[];
} {
  const { checksum, loadHints, complete } = parsePersistedArenaBuildMetadata(row);
  const missingCoreMetadata = !complete;
  const estimatedBytes = estimateArenaBuildBytes({
    blockCount: row.blockCount,
    voxelByteSize: row.voxelByteSize,
    voxelCompressedByteSize: row.voxelCompressedByteSize,
  });
  const deliveryClass = loadHints?.deliveryClass ?? classifyArenaBuildDelivery(estimatedBytes);
  const fullEstimatedBytes =
    Math.max(loadHints?.fullEstimatedBytes ?? 0, estimatedBytes ?? 0) || null;
  const isSnapshotClass = deliveryClass === "inline" || deliveryClass === "snapshot";

  const required: ArtifactRequirement[] = [];

  // snapshot artifacts are addressed by the build checksum; the persisted
  // hints record whether a smaller preview variant exists for this build
  const fullSnapshotRef = isSnapshotClass ? getSnapshotArtifactRef(row.id, "full", checksum) : null;
  if (fullSnapshotRef) {
    required.push({ kind: "snapshot", variant: "full", refs: [fullSnapshotRef] });
  }
  const previewNeeded =
    loadHints != null && loadHints.previewBlockCount < loadHints.fullBlockCount;
  if (previewNeeded && checksum) {
    const previewSnapshotRef = getSnapshotArtifactRef(row.id, "preview", checksum);
    required.push({
      kind: "snapshot",
      variant: "preview",
      refs: previewSnapshotRef ? [previewSnapshotRef] : [],
    });
  }

  const effectiveStreamMinBytes =
    typeof streamMinBytes === "number" && streamMinBytes > 0
      ? streamMinBytes
      : getArenaArtifactMinBytes();
  const streamEligible =
    checksum != null &&
    (deliveryClass === "stream-artifact" ||
      (fullEstimatedBytes != null && fullEstimatedBytes >= effectiveStreamMinBytes));
  if (streamEligible) {
    for (const variant of ["full", "preview"] as const) {
      const refs = getArenaBuildStreamArtifactFetchRefs(row.id, variant, checksum);
      required.push({ kind: "stream", variant, refs });
    }
  }

  // The binary artifact is what the client asks for first once binary reads are
  // on. Delivery falls back to the JSON object when it is absent, so a missing
  // one costs speed rather than correctness and would otherwise never surface:
  // coverage that ignored it would report a build as complete while the faster
  // path silently never fired. Every class gets one, including stream-class
  // builds, which the binary encoding makes small enough to serve whole.
  if (isBinarySnapshotArtifactEnabled() && checksum) {
    const binaryFullRef = getSnapshotArtifactRef(row.id, "full", checksum, "binary");
    required.push({
      kind: "snapshot-binary",
      variant: "full",
      refs: binaryFullRef ? [binaryFullRef] : [],
    });
    if (previewNeeded && isSnapshotClass) {
      const binaryPreviewRef = getSnapshotArtifactRef(row.id, "preview", checksum, "binary");
      required.push({
        kind: "snapshot-binary",
        variant: "preview",
        refs: binaryPreviewRef ? [binaryPreviewRef] : [],
      });
    }
  }

  return {
    missingCoreMetadata,
    // a snapshot-class build without core metadata cannot compute its refs yet
    needsSnapshotCompute: isSnapshotClass && missingCoreMetadata,
    required,
  };
}

export async function getArenaBuildArtifactStatuses(
  rows: readonly ArenaBuildArtifactStatusRow[],
  streamMinBytes?: number,
): Promise<ArenaBuildArtifactStatus[]> {
  const expectations = rows.map((row) => ({
    row,
    ...expectedArtifactRequirements(row, streamMinBytes),
  }));
  const allRefs = expectations.flatMap((entry) =>
    entry.required.flatMap((requirement) => requirement.refs),
  );
  const existing = allRefs.length > 0 ? await probeStorageObjects(allRefs) : new Set<string>();

  return expectations.map((entry) => ({
    buildId: entry.row.id,
    missingCoreMetadata: entry.missingCoreMetadata,
    needsSnapshotCompute: entry.needsSnapshotCompute,
    required: entry.required,
    missing: entry.required.filter(
      (requirement) => !requirement.refs.some((ref) => existing.has(refKey(ref))),
    ),
  }));
}

export function statusNeedsWork(status: ArenaBuildArtifactStatus): boolean {
  return status.missingCoreMetadata || status.needsSnapshotCompute || status.missing.length > 0;
}

export type ArenaArtifactCoverage = {
  eligibleBuilds: number;
  buildsWithBothVariants: number | null;
  buildsMissingVariants: number | null;
  artifactObjectsPresent: number | null;
  thresholdBytes: number;
  snapshotRequirements: number | null;
  snapshotMissing: number | null;
  binaryRequirements: number | null;
  binaryMissing: number | null;
  buildsMissingCoreMetadata: number | null;
  buildsNeedingSnapshotCompute: number | null;
  missingBuildIds: string[] | null;
  error: string | null;
};

export async function getArenaArtifactCoverage(
  modelKeys?: readonly string[],
): Promise<ArenaArtifactCoverage> {
  const rows = await prisma.build.findMany({
    where: arenaCohortBuildWhere(modelKeys),
    select: ARTIFACT_STATUS_BUILD_SELECT,
  });

  const thresholdBytes = getArenaArtifactMinBytes();

  try {
    const statuses = await getArenaBuildArtifactStatuses(rows);

    const streamStatuses = statuses.filter((status) =>
      status.required.some((requirement) => requirement.kind === "stream"),
    );
    const streamComplete = streamStatuses.filter(
      (status) => !status.missing.some((requirement) => requirement.kind === "stream"),
    ).length;

    const count = (
      list: ArenaBuildArtifactStatus[],
      pick: (status: ArenaBuildArtifactStatus) => ArtifactRequirement[],
      kind: ArtifactRequirement["kind"],
    ) =>
      list.reduce(
        (total, status) =>
          total + pick(status).filter((requirement) => requirement.kind === kind).length,
        0,
      );

    return {
      eligibleBuilds: streamStatuses.length,
      buildsWithBothVariants: streamComplete,
      buildsMissingVariants: streamStatuses.length - streamComplete,
      artifactObjectsPresent:
        count(statuses, (status) => status.required, "stream") +
        count(statuses, (status) => status.required, "snapshot") +
        count(statuses, (status) => status.required, "snapshot-binary") -
        count(statuses, (status) => status.missing, "stream") -
        count(statuses, (status) => status.missing, "snapshot") -
        count(statuses, (status) => status.missing, "snapshot-binary"),
      thresholdBytes,
      snapshotRequirements: count(statuses, (status) => status.required, "snapshot"),
      snapshotMissing: count(statuses, (status) => status.missing, "snapshot"),
      binaryRequirements: count(statuses, (status) => status.required, "snapshot-binary"),
      binaryMissing: count(statuses, (status) => status.missing, "snapshot-binary"),
      buildsMissingCoreMetadata: statuses.filter((status) => status.missingCoreMetadata).length,
      buildsNeedingSnapshotCompute: statuses.filter((status) => status.needsSnapshotCompute)
        .length,
      missingBuildIds: statuses.filter(statusNeedsWork).map((status) => status.buildId),
      error: null,
    };
  } catch (error) {
    return {
      eligibleBuilds: rows.length,
      buildsWithBothVariants: null,
      buildsMissingVariants: null,
      artifactObjectsPresent: null,
      thresholdBytes,
      snapshotRequirements: null,
      snapshotMissing: null,
      binaryRequirements: null,
      binaryMissing: null,
      buildsMissingCoreMetadata: null,
      buildsNeedingSnapshotCompute: null,
      missingBuildIds: null,
      error: error instanceof Error ? error.message : "artifact status lookup failed",
    };
  }
}
