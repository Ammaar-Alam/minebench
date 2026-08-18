#!/usr/bin/env -S tsx

import "dotenv/config";
import { gunzipSync } from "node:zlib";
import { decodeBinaryArtifact } from "../lib/arena/binaryArtifact";
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
    buildLoadHints?: { previewBlockCount?: unknown; fullBlockCount?: unknown } | null;
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
  const blocks = payload.voxelBuild?.blocks;
  if (!Array.isArray(blocks)) return "snapshot voxelBuild.blocks missing";

  // The client trusts serverValidated and skips voxel validation, comparing the
  // received length against the count in buildLoadHints. A truncated blocks
  // array therefore leaves the viewer unready and voting blocked while still
  // carrying a valid envelope, so the audit has to check the same total.
  const hints = payload.buildLoadHints;
  const announced =
    variant === "preview" ? hints?.previewBlockCount : hints?.fullBlockCount;
  if (typeof announced === "number" && Number.isFinite(announced) && announced > 0) {
    if (blocks.length !== Math.floor(announced)) {
      return `snapshot block count mismatch (hints ${Math.floor(announced)}, blocks ${blocks.length})`;
    }
  }

  // spot-check entries rather than every block: a truncation or corruption that
  // survives the count check still shows up at the boundaries
  for (const index of [0, Math.floor(blocks.length / 2), blocks.length - 1]) {
    const block = blocks[index] as { x?: unknown; y?: unknown; z?: unknown; type?: unknown };
    if (!block || typeof block !== "object") return `snapshot block ${index} is not an object`;
    if (
      typeof block.x !== "number" ||
      typeof block.y !== "number" ||
      typeof block.z !== "number" ||
      typeof block.type !== "string"
    ) {
      return `snapshot block ${index} is malformed`;
    }
  }
  return null;
}

function verifyBinarySnapshotPayload(
  bytes: Uint8Array,
  buildId: string,
  variant: ArtifactRequirement["variant"],
  expectedChecksum: string | null,
): string | null {
  let decoded: ReturnType<typeof decodeBinaryArtifact>;
  try {
    decoded = decodeBinaryArtifact(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `binary snapshot payload is invalid: ${message}`;
  }

  const envelope = decoded.envelope as {
    buildId?: unknown;
    variant?: unknown;
    checksum?: unknown;
    serverValidated?: unknown;
    buildLoadHints?: {
      previewBlockCount?: unknown;
      fullBlockCount?: unknown;
    } | null;
  };
  if (envelope.buildId !== buildId) {
    return `binary snapshot buildId mismatch (${String(envelope.buildId)})`;
  }
  if (envelope.variant !== variant) {
    return `binary snapshot variant mismatch (${String(envelope.variant)})`;
  }
  if (expectedChecksum && envelope.checksum !== expectedChecksum) {
    return `binary snapshot checksum mismatch (${String(envelope.checksum)})`;
  }
  if (envelope.serverValidated !== true) {
    return "binary snapshot is not marked serverValidated";
  }

  const announced =
    variant === "preview"
      ? envelope.buildLoadHints?.previewBlockCount
      : envelope.buildLoadHints?.fullBlockCount;
  if (typeof announced === "number" && Number.isFinite(announced) && announced >= 0) {
    if (decoded.blocks.count !== Math.floor(announced)) {
      return `binary snapshot block count mismatch (hints ${Math.floor(announced)}, blocks ${decoded.blocks.count})`;
    }
  }
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

  // Every event is parsed, not just the first and last: a truncated or
  // malformed middle chunk still leaves a valid hello and complete pair, and
  // clients reject the artifact on the block total. Checking the ends only
  // would let this audit pass artifacts production falls back on.
  let hello: {
    type?: unknown;
    buildId?: unknown;
    variant?: unknown;
    checksum?: unknown;
    totalBlocks?: unknown;
    chunkCount?: unknown;
  } | null = null;
  let complete: { type?: unknown; totalBlocks?: unknown } | null = null;
  let seenBlocks = 0;
  let seenChunks = 0;

  for (const [index, line] of lines.entries()) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return `stream artifact has invalid ndjson at line ${index + 1}`;
    }

    if (index === 0) {
      if (event.type !== "hello") return "stream artifact does not start with a hello event";
      hello = event;
      continue;
    }
    if (event.type === "chunk") {
      if (complete) return `stream artifact has a chunk after complete at line ${index + 1}`;
      const blocks = event.blocks;
      if (!Array.isArray(blocks)) return `stream chunk at line ${index + 1} has no blocks array`;
      // Production trusts the stream's serverValidated flag and skips voxel
      // validation, gating readiness on array length alone, so malformed or
      // null entries render as missing or phantom geometry while still
      // enabling voting. Spot-check entries in every chunk.
      for (const at of [0, Math.floor(blocks.length / 2), blocks.length - 1]) {
        if (blocks.length === 0) break;
        const block = blocks[at] as { x?: unknown; y?: unknown; z?: unknown; type?: unknown } | null;
        if (!block || typeof block !== "object") {
          return `stream chunk at line ${index + 1} has a non-object block at ${at}`;
        }
        if (
          typeof block.x !== "number" ||
          typeof block.y !== "number" ||
          typeof block.z !== "number" ||
          typeof block.type !== "string"
        ) {
          return `stream chunk at line ${index + 1} has a malformed block at ${at}`;
        }
      }
      // chunk indexes are 1-based (iterateArenaBuildChunks yields index + 1)
      if (typeof event.index === "number" && event.index !== seenChunks + 1) {
        return `stream chunk out of order at line ${index + 1} (index ${event.index}, expected ${seenChunks + 1})`;
      }
      seenBlocks += blocks.length;
      seenChunks += 1;
      continue;
    }
    if (event.type === "complete") {
      complete = event;
      continue;
    }
    // the client throws on an error event and ignores pings, so anything else
    // makes the artifact undeliverable no matter how well-formed the rest is
    if (event.type === "ping") continue;
    if (event.type === "error") {
      return `stream artifact carries an error event at line ${index + 1}: ${String(event.message ?? "")}`;
    }
    return `stream artifact has an unsupported event type at line ${index + 1}: ${String(event.type)}`;
  }

  if (!hello) return "stream artifact has no hello event";
  if (hello.buildId !== buildId) return `stream hello buildId mismatch (${String(hello.buildId)})`;
  if (hello.variant !== variant) return `stream hello variant mismatch (${String(hello.variant)})`;
  if (expectedChecksum && hello.checksum !== expectedChecksum) {
    return `stream hello checksum mismatch (${String(hello.checksum)})`;
  }
  if (!complete) return "stream artifact does not end with a complete event";

  const announced = typeof hello.totalBlocks === "number" ? hello.totalBlocks : null;
  if (announced != null && announced !== seenBlocks) {
    return `stream block total mismatch (hello ${announced}, chunks ${seenBlocks})`;
  }
  const completed = typeof complete.totalBlocks === "number" ? complete.totalBlocks : null;
  if (completed != null && completed !== seenBlocks) {
    return `stream complete total mismatch (complete ${completed}, chunks ${seenBlocks})`;
  }
  if (typeof hello.chunkCount === "number" && hello.chunkCount !== seenChunks) {
    return `stream chunk count mismatch (hello ${hello.chunkCount}, seen ${seenChunks})`;
  }
  return null;
}

async function checkSignedUrlDelivery(
  kind: ArtifactRequirement["kind"],
  buildId: string,
  variant: ArtifactRequirement["variant"],
  checksum: string | null,
): Promise<string | null> {
  const signedUrl =
    kind === "stream"
      ? await createArenaBuildStreamArtifactSignedUrl(buildId, variant, checksum)
      : await createArenaBuildSnapshotArtifactSignedUrl(buildId, variant, checksum, {
          format: kind === "snapshot-binary" ? "binary" : "json",
        });
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
  if (requirement.kind === "snapshot-binary") {
    const match = path.match(/-([0-9a-f]{64})\.mbv4$/);
    return match?.[1] ?? null;
  }
  const match =
    path.match(/\/checksum\/([0-9a-f]{64})\//) ??
    path.match(/-([0-9a-f]{64})\.ndjson$/);
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
        requirement.kind === "stream"
          ? verifyStreamPayload(bytes, row.id, requirement.variant, checksum)
          : requirement.kind === "snapshot-binary"
            ? verifyBinarySnapshotPayload(bytes, row.id, requirement.variant, checksum)
            : verifySnapshotPayload(bytes, row.id, requirement.variant, checksum);
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
  if (coverage.binaryRequirements) {
    console.log(
      `- binary requirements: ${coverage.binaryRequirements} (missing ${coverage.binaryMissing})`,
    );
  }
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
