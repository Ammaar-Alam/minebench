import assert from "node:assert/strict";
import type { ArenaBuildSource, ArenaBuildLoadHints } from "../../../lib/arena/buildArtifacts";

// A build large enough for the full variant to land in the "snapshot" delivery
// class while its surface preview stays in the "inline" class. Blocks are placed
// on a stride-2 lattice inside a 512-grid so no two blocks share a face; every
// block is therefore exposed and survives `filterRenderableVoxelBuild`, keeping
// fullBlockCount equal to the input block count regardless of sampling.
const FULL_BLOCK_COUNT = 70_000;
const INLINE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB (default ARENA_INLINE_INITIAL_MAX_BYTES)
const SNAPSHOT_MAX_BYTES = 15 * 1024 * 1024; // 15 MiB (default ARENA_SNAPSHOT_MAX_BYTES)

function makeLargeRenderableBuild(): { version: "1.0"; blocks: Array<{ x: number; y: number; z: number; type: string }> } {
  const axisCells = 256; // stride-2 positions -> even coords 0..510, fits a 512-grid
  const blocks: Array<{ x: number; y: number; z: number; type: string }> = [];
  for (let i = 0; i < FULL_BLOCK_COUNT; i += 1) {
    const x = (i % axisCells) * 2;
    const y = (Math.floor(i / axisCells) % axisCells) * 2;
    const z = Math.floor(i / (axisCells * axisCells)) * 2;
    blocks.push({ x, y, z, type: "stone" });
  }
  return { version: "1.0", blocks };
}

// Mirrors `shouldInlineInitialInAdaptiveMode` in app/api/arena/matchup/route.ts so the
// test can prove the stale-hints misroute is gone without booting the matchup route.
function shouldInlineInAdaptiveMode(deliveryClass: ArenaBuildLoadHints["initialDeliveryClass"]): boolean {
  return deliveryClass === "inline";
}

function shouldInlineInitialInAdaptiveMode(
  hints: ArenaBuildLoadHints,
  inlineMaxBytes: number,
): boolean {
  const deliveryClass = hints.initialDeliveryClass ?? hints.deliveryClass;
  if (!shouldInlineInAdaptiveMode(deliveryClass)) return false;
  if (!Number.isFinite(inlineMaxBytes) || inlineMaxBytes <= 0) return false;
  const estimatedBytes = hints.initialEstimatedBytes;
  return typeof estimatedBytes === "number" && estimatedBytes > 0 && estimatedBytes <= inlineMaxBytes;
}

async function main() {
  // Force the disabled-artifacts debug branch. Keep the preview stage enabled so
  // `createPrepared` first selects "preview" (full bytes >= preview trigger, fewer
  // preview blocks than full) and the disabled branch then flips the variant to
  // "full". Pin the delivery-class thresholds to canonical defaults so the fixture
  // is guaranteed to land on a cross-class boundary (full=snapshot, preview=inline)
  // regardless of ambient env.
  process.env.ARENA_ARTIFACTS_ENABLED = "0";
  process.env.ARENA_PREVIEW_STAGE_ENABLED = "1";
  process.env.ARENA_PREVIEW_TARGET_BLOCKS = "3000";
  process.env.ARENA_INLINE_INITIAL_MAX_BYTES = String(INLINE_MAX_BYTES);
  process.env.ARENA_SNAPSHOT_MAX_BYTES = String(SNAPSHOT_MAX_BYTES);
  process.env.ARENA_PREVIEW_TRIGGER_BYTES = String(256 * 1024);
  process.env.ARENA_ARTIFACT_MIN_BYTES = String(SNAPSHOT_MAX_BYTES + 1);

  const { prepareArenaBuild, pickInitialBuild, serializeArenaBuildLoadHints, parsePersistedArenaBuildLoadHints } =
    await import("../../../lib/arena/buildArtifacts");
  const { classifyArenaBuildDelivery } = await import("../../../lib/arena/buildDeliveryPolicy");

  const build = makeLargeRenderableBuild();
  const source: ArenaBuildSource = {
    id: "disabled-branch-cross-class-fixture",
    gridSize: 512,
    palette: "simple",
    blockCount: build.blocks.length,
    voxelByteSize: null,
    voxelCompressedByteSize: null,
    voxelSha256: null,
    voxelData: build,
    voxelStorageBucket: null,
    voxelStoragePath: null,
    voxelStorageEncoding: null,
  };

  const prepared = await prepareArenaBuild(source);
  const hints = prepared.hints;

  // --- Fixture integrity: the build really spans a delivery-class boundary. ---
  assert.equal(hints.fullBlockCount, FULL_BLOCK_COUNT, "full fixture must keep every block renderable");
  assert.ok(hints.previewBlockCount > 0 && hints.previewBlockCount < hints.fullBlockCount,
    "preview must be a strict subset of the full build so createPrepared first selects 'preview'");
  assert.equal(hints.fullEstimatedBytes, FULL_BLOCK_COUNT * 34,
    "full estimate is the block-count floor (no voxel/compressed metadata supplied)");
  assert.equal(classifyArenaBuildDelivery(hints.fullEstimatedBytes), "snapshot",
    "fixture full size must land in the snapshot class");
  assert.equal(classifyArenaBuildDelivery(hints.previewBlockCount * 34), "inline",
    "fixture preview size must land in the inline class (cross-class boundary)");

  // --- The disabled branch must force "full" AND resync the paired fields. ---
  assert.equal(hints.initialVariant, "full",
    "disabled-artifacts branch must force the initial variant to 'full'");
  assert.equal(hints.initialEstimatedBytes, hints.fullEstimatedBytes,
    "initialEstimatedBytes must be resynced to the full variant after the override");
  assert.equal(hints.initialDeliveryClass, hints.deliveryClass,
    "initialDeliveryClass must be resynced to the full variant after the override");
  assert.equal(hints.initialDeliveryClass, "snapshot",
    "resynced initialDeliveryClass must match the full/snapshot class, not the stale preview/inline class");
  assert.notEqual(hints.initialDeliveryClass, "inline",
    "resynced initialDeliveryClass must not retain the stale preview 'inline' label");

  // --- The paired-field invariant createPrepared maintains on its own full path. ---
  assert.equal(
    classifyArenaBuildDelivery(hints.initialEstimatedBytes),
    hints.initialDeliveryClass,
    "initialDeliveryClass must agree with classifyArenaBuildDelivery(initialEstimatedBytes)",
  );

  // --- Variant selection still asks for the full build (the override's intent). ---
  assert.equal(pickInitialBuild(prepared), prepared.fullBuild,
    "pickInitialBuild must serve the full build now that initialVariant is 'full'");

  // --- The adaptive inline gate must reject the snapshot-class full build. ---
  // Choose a cap inside the misroute window [previewBytes, fullBytes) where the
  // buggy stale hints (inline / preview-sized bytes) would have passed the gate
  // and inlined the full ~2.38 MiB body. A cap anywhere in that window must now
  // be rejected because initialDeliveryClass is "snapshot", not "inline".
  const capsInMisrouteWindow = [
    hints.previewBlockCount * 34 + 1,
    Math.floor((hints.previewBlockCount * 34 + hints.fullEstimatedBytes) / 2),
    hints.fullEstimatedBytes - 1,
  ];
  for (const cap of capsInMisrouteWindow) {
    assert.ok(cap > hints.previewBlockCount * 34 && cap < hints.fullEstimatedBytes,
      `cap ${cap} must stay inside the misroute window`);
    assert.equal(
      shouldInlineInitialInAdaptiveMode(hints, cap),
      false,
      `snapshot-class full build must not pass the inline gate at cap ${cap} after resync`,
    );
  }
  // With the cap disabled (0), the short-circuit must hold regardless.
  assert.equal(shouldInlineInitialInAdaptiveMode(hints, 0), false,
    "inline gate must short-circuit when the inline max bytes is 0");

  // --- Persisted hints must round-trip as consistent (parse recomputes labels from bytes). ---
  const roundTripped = parsePersistedArenaBuildLoadHints(serializeArenaBuildLoadHints(hints));
  assert.ok(roundTripped, "serialized hints must round-trip through the persistence parser");
  assert.equal(roundTripped!.initialVariant, "full");
  assert.equal(roundTripped!.initialEstimatedBytes, hints.fullEstimatedBytes,
    "persisted initialEstimatedBytes must remain the full-variant estimate");
  assert.equal(roundTripped!.initialDeliveryClass, "snapshot",
    "parser recomputed initialDeliveryClass must be snapshot (derived from full-sized bytes)");
  assert.equal(roundTripped!.deliveryClass, "snapshot");
  assert.equal(
    roundTripped!.initialDeliveryClass,
    classifyArenaBuildDelivery(roundTripped!.initialEstimatedBytes),
    "round-tripped pair must remain consistent",
  );

  console.log("disabled-branch cross-class divergence checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
