#!/usr/bin/env -S tsx

import "dotenv/config";
import { gunzipSync } from "node:zlib";
import { findCatalogEntryBySlugOrKey } from "../lib/ai/modelCatalog";
import {
  ARTIFACT_STATUS_BUILD_SELECT,
  expectedArtifactRequirements,
  getArenaArtifactCoverage,
  type ArtifactRef,
  type ArtifactRequirement,
} from "../lib/arena/artifactCoverage";
import { createArenaBuildSnapshotArtifactSignedUrl } from "../lib/arena/buildSnapshotArtifacts";
import { createArenaBuildStreamArtifactSignedUrl } from "../lib/arena/buildStream";
import { arenaCohortBuildWhere } from "../lib/arena/eligibility";
import { getSupabaseStorageConfig } from "../lib/storage/buildPayload";
import { prisma } from "../lib/prisma";

type Args = {
  deep: boolean;
  modelKeys: string[] | undefined;
  limit: number | undefined;
};

type AuditFailure = {
  buildId: string;
  requirement: string;
  reason: string;
};

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const deep = args.includes("--deep");

  let modelKeys: string[] | undefined;
  const modelIndex = args.indexOf("--model");
  if (modelIndex >= 0) {
    const raw = args[modelIndex + 1]?.trim();
    if (!raw) throw new Error("--model expects a model slug or key");
    const entry = findCatalogEntryBySlugOrKey(raw);
    if (!entry) throw new Error(`Unknown model: ${raw}`);
    modelKeys = [entry.key];
  }

  let limit: number | undefined;
  const limitIndex = args.indexOf("--limit");
  if (limitIndex >= 0) {
    const parsed = Number.parseInt(args[limitIndex + 1] ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit expects a positive integer");
    limit = parsed;
  }

  return { deep, modelKeys, limit };
}

function describeRequirement(requirement: ArtifactRequirement): string {
  return `${requirement.kind}/${requirement.variant}`;
}

function maybeGunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return gunzipSync(Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength));
}

async function fetchArtifactBytes(ref: ArtifactRef): Promise<Uint8Array | null> {
  const config = getSupabaseStorageConfig();
  const encodedPath = ref.path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const resp = await fetch(
    `${config.url}/storage/v1/object/${encodeURIComponent(ref.bucket)}/${encodedPath}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
      },
      cache: "no-store",
    },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`fetch failed (${resp.status}): ${text || "empty response"}`);
  }
  return maybeGunzip(new Uint8Array(await resp.arrayBuffer()));
}

function verifySnapshotPayload(
  bytes: Uint8Array,
  buildId: string,
  variant: ArtifactRequirement["variant"],
  expectedChecksum: string | null,
): string | null {
  let payload: {
    buildId?: unknown;
    variant?: unknown;
    checksum?: unknown;
    voxelBuild?: { blocks?: unknown } | null;
  };
  try {
    payload = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return "snapshot payload is not valid json";
  }
  if (payload.buildId !== buildId) return `snapshot buildId mismatch (${String(payload.buildId)})`;
  if (payload.variant !== variant) return `snapshot variant mismatch (${String(payload.variant)})`;
  if (expectedChecksum && payload.checksum !== expectedChecksum) {
    return `snapshot checksum mismatch (${String(payload.checksum)})`;
  }
  if (!Array.isArray(payload.voxelBuild?.blocks)) return "snapshot voxelBuild.blocks missing";
  return null;
}

function verifyStreamPayload(
  bytes: Uint8Array,
  buildId: string,
  variant: ArtifactRequirement["variant"],
  expectedChecksum: string | null,
): string | null {
  const lines = Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return "stream artifact is empty";

  let hello: { type?: unknown; buildId?: unknown; variant?: unknown; checksum?: unknown };
  let last: { type?: unknown };
  try {
    hello = JSON.parse(lines[0]);
    last = JSON.parse(lines[lines.length - 1]);
  } catch {
    return "stream artifact contains invalid ndjson";
  }
  if (hello.type !== "hello") return "stream artifact does not start with a hello event";
  if (hello.buildId !== buildId) return `stream hello buildId mismatch (${String(hello.buildId)})`;
  if (hello.variant !== variant) return `stream hello variant mismatch (${String(hello.variant)})`;
  if (expectedChecksum && hello.checksum !== expectedChecksum) {
    return `stream hello checksum mismatch (${String(hello.checksum)})`;
  }
  if (last.type !== "complete") return "stream artifact does not end with a complete event";
  return null;
}

async function checkSignedUrlDelivery(
  kind: ArtifactRequirement["kind"],
  buildId: string,
  variant: ArtifactRequirement["variant"],
  checksum: string | null,
): Promise<string | null> {
  const signedUrl =
    kind === "snapshot"
      ? await createArenaBuildSnapshotArtifactSignedUrl(buildId, variant, checksum)
      : await createArenaBuildStreamArtifactSignedUrl(buildId, variant, checksum);
  if (!signedUrl) return "signed url unavailable (signing disabled or object missing)";
  // a ranged read proves anonymous delivery without re-downloading the body
  const resp = await fetch(signedUrl, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
    cache: "no-store",
  });
  if (resp.status !== 200 && resp.status !== 206) {
    return `signed url fetch failed (${resp.status})`;
  }
  await resp.arrayBuffer().catch(() => undefined);
  return null;
}

// the requirement checksum is the one embedded in the artifact path
function requirementChecksum(requirement: ArtifactRequirement): string | null {
  const path = requirement.refs[0]?.path ?? "";
  if (requirement.kind === "snapshot") {
    const match = path.match(/-([0-9a-f]{64})\.json$/);
    return match?.[1] ?? null;
  }
  const match = path.match(/\/checksum\/([0-9a-f]{64})\//) ?? path.match(/-([0-9a-f]{64})\.ndjson$/);
  return match?.[1] ?? null;
}

async function runDeepAudit(args: Args): Promise<number> {
  const rows = await prisma.build.findMany({
    where: arenaCohortBuildWhere(args.modelKeys),
    select: ARTIFACT_STATUS_BUILD_SELECT,
    orderBy: { id: "asc" },
    ...(args.limit ? { take: args.limit } : {}),
  });
  console.log(`Deep-auditing ${rows.length} builds`);

  const failures: AuditFailure[] = [];
  let checkedArtifacts = 0;

  for (const [index, row] of rows.entries()) {
    const { missingCoreMetadata, needsSnapshotCompute, required } = expectedArtifactRequirements(row);
    if (missingCoreMetadata) {
      failures.push({ buildId: row.id, requirement: "core-metadata", reason: "voxelSha256 or hints missing" });
    }
    if (needsSnapshotCompute) {
      failures.push({ buildId: row.id, requirement: "snapshot-compute", reason: "snapshot checksums not recorded" });
    }

    for (const requirement of required) {
      const label = describeRequirement(requirement);
      const checksum = requirementChecksum(requirement);
      let bytes: Uint8Array | null = null;
      let fetchError: string | null = null;
      for (const ref of requirement.refs) {
        try {
          bytes = await fetchArtifactBytes(ref);
        } catch (err) {
          fetchError = err instanceof Error ? err.message : String(err);
        }
        if (bytes) break;
      }
      if (!bytes) {
        failures.push({
          buildId: row.id,
          requirement: label,
          reason: fetchError ?? "object missing in storage",
        });
        continue;
      }

      const contentError =
        requirement.kind === "snapshot"
          ? verifySnapshotPayload(bytes, row.id, requirement.variant, checksum)
          : verifyStreamPayload(bytes, row.id, requirement.variant, checksum);
      if (contentError) {
        failures.push({ buildId: row.id, requirement: label, reason: contentError });
        continue;
      }

      const deliveryError = await checkSignedUrlDelivery(
        requirement.kind,
        row.id,
        requirement.variant,
        checksum,
      );
      if (deliveryError) {
        failures.push({ buildId: row.id, requirement: label, reason: deliveryError });
        continue;
      }
      checkedArtifacts += 1;
    }

    if ((index + 1) % 50 === 0) {
      console.log(`- audited ${index + 1}/${rows.length} builds`);
    }
  }

  console.log(`Deep audit complete: ${checkedArtifacts} artifacts verified, ${failures.length} failures.`);
  for (const failure of failures.slice(0, 50)) {
    console.log(`- FAIL build=${failure.buildId} ${failure.requirement}: ${failure.reason}`);
  }
  if (failures.length > 50) {
    console.log(`- ... (${failures.length - 50} more failures)`);
  }
  return failures.length === 0 ? 0 : 1;
}

async function runFastAudit(args: Args): Promise<number> {
  const coverage = await getArenaArtifactCoverage(args.modelKeys);
  if (coverage.error) {
    console.error(`Coverage lookup failed: ${coverage.error}`);
    return 1;
  }
  console.log("Arena artifact coverage");
  console.log(`- eligible stream builds: ${coverage.eligibleBuilds}`);
  console.log(`- stream builds complete: ${coverage.buildsWithBothVariants}`);
  console.log(`- snapshot requirements: ${coverage.snapshotRequirements} (missing ${coverage.snapshotMissing})`);
  console.log(`- builds missing core metadata: ${coverage.buildsMissingCoreMetadata}`);
  console.log(`- builds needing snapshot compute: ${coverage.buildsNeedingSnapshotCompute}`);
  const missing = coverage.missingBuildIds ?? [];
  if (missing.length > 0) {
    console.log(`- builds needing work: ${missing.length}`);
    for (const buildId of missing.slice(0, 20)) console.log(`  - ${buildId}`);
    if (missing.length > 20) console.log(`  - ... (${missing.length - 20} more)`);
    return 1;
  }
  console.log("All policy-required artifacts are present.");
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const exitCode = args.deep ? await runDeepAudit(args) : await runFastAudit(args);
  process.exitCode = exitCode;
}

void main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
