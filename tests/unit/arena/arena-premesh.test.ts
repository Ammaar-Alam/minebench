import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createVoxelGroupAsync,
  type VoxelMeshPayload,
} from "../../../lib/voxel/mesh";
import type { VoxelBuild } from "../../../lib/voxel/types";
import { getPalette } from "../../../lib/blocks/palettes";
import { clientMetricBatchSchema } from "../../../lib/observability/customMetrics";
import {
  claimArenaPremesh,
  type ArenaPremeshEntry,
} from "../../../lib/arena/premesh";

function makeFakeTexture(): THREE.Texture {
  const texture = new THREE.Texture();
  texture.image = { width: 16, height: 16 };
  return texture;
}

function makeFakeMeshPayload(blockCount: number): VoxelMeshPayload {
  return {
    filteredBlockCount: blockCount,
    bounds: {
      min: [0, 0, 0],
      max: [1, 1, 1],
      center: [0.5, 0.5, 0.5],
      radius: 1,
    },
    opaque: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      normals: new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1]),
      colors: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255]),
      indices: new Uint32Array([0, 1, 2]),
    },
    cutout: null,
    transparent: null,
    water: null,
    emissive: null,
  };
}

async function testPremeshedPayloadPromiseConsumed() {
  const build: VoxelBuild = {
    version: "1.0",
    blocks: [
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 0, y: 1, z: 0, type: "stone" },
    ],
  };
  const palette = getPalette("simple");
  const tex = makeFakeTexture();
  const fakePayload = makeFakeMeshPayload(2);
  let resolvePremesh!: (payload: VoxelMeshPayload) => void;
  const premeshedPromise = new Promise<VoxelMeshPayload>((resolve) => {
    resolvePremesh = resolve;
  });
  let consumed = false;

  const stages: string[] = [];
  const groupPromise = createVoxelGroupAsync(build, palette, tex, {
    premeshedPayloadPromise: premeshedPromise,
    onPremeshedPayloadConsumed: (promise) => {
      assert.equal(promise, premeshedPromise);
      consumed = true;
    },
    onStage: (e) => stages.push(`${e.stage}:${e.strategy}:${e.cacheStatus}`),
  });

  await Promise.resolve();
  assert.equal(consumed, false, "an in-flight premesh must not be consumed early");
  resolvePremesh(fakePayload);
  const group = await groupPromise;

  assert.equal(group.stats.blockCount, 2);
  assert.equal(consumed, true, "the mesher consumes the entry after awaiting it");
  assert.ok(stages.includes("mesh_started:worker:undefined"));
  assert.ok(stages.includes("mesh_payload_complete:worker:prewarm-hit"));
  assert.ok(stages.includes("three_group_complete:worker:prewarm-hit"));
  group.dispose();
}

async function testPremeshedPayloadFallbackOnRejection() {
  const build: VoxelBuild = {
    version: "1.0",
    blocks: [
      { x: 0, y: 0, z: 0, type: "stone" },
    ],
  };
  const palette = getPalette("simple");
  const tex = makeFakeTexture();
  const rejectedPromise = Promise.reject(new Error("Worker terminated unexpectedly"));

  // Should gracefully fall back to local meshing without throwing
  const group = await createVoxelGroupAsync(build, palette, tex, {
    premeshedPayloadPromise: rejectedPromise,
  });

  assert.equal(group.stats.blockCount, 1);
  group.dispose();
}

function testMatchupStageMetricsValidation() {
  const parsed = clientMetricBatchSchema.parse({
    samples: [
      {
        kind: "matchup",
        mode: "random",
        laneABlocks: "under-8k",
        laneBBlocks: "8k-50k",
        headersMs: 45,
        bodyMs: 120,
        totalMs: 220,
      },
      {
        kind: "matchup-stage",
        stage: "preview_ready",
        mode: "random",
        laneABlocks: "under-8k",
        laneBBlocks: "8k-50k",
        durationMs: 180,
      },
      {
        kind: "matchup-stage",
        stage: "vote_ready",
        mode: "random",
        laneABlocks: "under-8k",
        laneBBlocks: "8k-50k",
        durationMs: 210,
      },
      {
        kind: "voxel",
        surface: "arena",
        variant: "full",
        strategy: "worker",
        cacheStatus: "prewarm-hit",
        blockCountBucket: "under-8k",
        renderedBlockCountBucket: "under-8k",
        animated: false,
        queueMs: 0,
        atlasMs: 5,
        payloadMs: 12,
        groupMs: 4,
        meshMs: 16,
        firstRenderMs: 20,
        revealMs: 20,
        totalMs: 25,
      },
    ],
  });

  assert.equal(parsed.samples.length, 4);
  assert.equal(parsed.samples[1].kind, "matchup-stage");
  if (parsed.samples[1].kind === "matchup-stage") {
    assert.equal(parsed.samples[1].stage, "preview_ready");
    assert.equal(parsed.samples[1].durationMs, 180);
  }
}

function testArenaPremeshMapLifecycle() {
  const premeshMap = new Map<string, ArenaPremeshEntry>();

  const ARENA_PREMESH_MAX_BLOCK_COUNT = 150_000;

  // 1. 150k admission threshold
  function shouldAdmitPremesh(blockCount: number): boolean {
    return blockCount > 0 && blockCount <= ARENA_PREMESH_MAX_BLOCK_COUNT;
  }

  assert.equal(shouldAdmitPremesh(0), false);
  assert.equal(shouldAdmitPremesh(100), true);
  assert.equal(shouldAdmitPremesh(150_000), true);
  assert.equal(shouldAdmitPremesh(150_001), false);

  // 2. Queued work yields to the visible lane instead of delaying it
  const fakePayload = makeFakeMeshPayload(10);
  const promise1 = Promise.resolve(fakePayload);
  const queuedController = new AbortController();
  premeshMap.set("queued", {
    matchupId: "matchup-1",
    controller: queuedController,
    promise: promise1,
    started: false,
  });

  assert.equal(claimArenaPremesh(premeshMap, "queued"), null);
  assert.equal(queuedController.signal.aborted, true);
  assert.equal(premeshMap.has("queued"), false);

  // 3. Started work is reused rather than duplicated
  const startedController = new AbortController();
  premeshMap.set("started", {
    matchupId: "matchup-1",
    controller: startedController,
    promise: promise1,
    started: true,
  });
  assert.equal(claimArenaPremesh(premeshMap, "started"), promise1);
  assert.equal(startedController.signal.aborted, false);
  assert.equal(premeshMap.has("started"), true);

  // 4. Entry consumption
  function consumePremesh(key: string): Promise<VoxelMeshPayload> | null {
    const entry = premeshMap.get(key);
    if (!entry) return null;
    premeshMap.delete(key);
    return entry.promise;
  }

  const consumed = consumePremesh("started");
  assert.equal(consumed, promise1);
  assert.equal(premeshMap.has("started"), false);
  assert.equal(consumePremesh("started"), null);

  // 5. Aborting on matchup advance
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  premeshMap.set("b-1", {
    matchupId: "m-1",
    controller: ctrlA,
    promise: promise1,
    started: true,
  });
  premeshMap.set("b-2", {
    matchupId: "m-2",
    controller: ctrlB,
    promise: promise1,
    started: false,
  });

  function abortPremeshedMeshes(matchupId?: string) {
    for (const [key, entry] of premeshMap) {
      if (matchupId && entry.matchupId !== matchupId) continue;
      entry.controller.abort();
      premeshMap.delete(key);
    }
  }

  abortPremeshedMeshes("m-1");
  assert.equal(ctrlA.signal.aborted, true);
  assert.equal(ctrlB.signal.aborted, false);
  assert.equal(premeshMap.has("b-1"), false);
  assert.equal(premeshMap.has("b-2"), true);

  // 6. Unmount cleanup (aborts all remaining)
  abortPremeshedMeshes();
  assert.equal(ctrlB.signal.aborted, true);
  assert.equal(premeshMap.size, 0);
}

function testMatchupRequestModeTracking() {
  const requestModes = new Map<string, "random" | "forced">();
  function setMatchupRequestMode(id: string, mode: "random" | "forced") {
    if (requestModes.size > 200) {
      const firstKey = requestModes.keys().next().value;
      if (firstKey) requestModes.delete(firstKey);
    }
    requestModes.set(id, mode);
  }

  setMatchupRequestMode("matchup-random-1", "random");
  setMatchupRequestMode("matchup-forced-1", "forced");

  assert.equal(requestModes.get("matchup-random-1"), "random");
  assert.equal(requestModes.get("matchup-forced-1"), "forced");
  assert.equal(requestModes.get("matchup-unknown"), undefined);
}

async function main() {
  await testPremeshedPayloadPromiseConsumed();
  await testPremeshedPayloadFallbackOnRejection();
  testMatchupStageMetricsValidation();
  testArenaPremeshMapLifecycle();
  testMatchupRequestModeTracking();
  console.log("arena premesh and stage timing unit tests passed");
}

main();
