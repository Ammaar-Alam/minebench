import assert from "node:assert/strict";
import * as THREE from "three";
import { getPalette } from "../../../lib/blocks/palettes";
import { encodeBinaryVoxelBuild } from "../../../lib/voxel/binaryBuild";
import { createVoxelWorldScene } from "../../../lib/voxel/worldScene";
import {
  VOXEL_WORLD_MIXED_LEAF_SIZE,
  type VoxelWorldDelivery,
  type VoxelWorldManifest,
  type VoxelWorldPartRef,
  type VoxelWorldRegion,
  type VoxelWorldRegionPage,
  type VoxelWorldRegionPageRef,
} from "../../../lib/voxel/world";
import type { VoxelBlock } from "../../../lib/voxel/types";

const SHA = "a".repeat(64);

function source() {
  return {
    format: "build_json" as const,
    sha256: SHA,
    evaluatorVersion: 1,
  };
}

function localPart(key: string, byteSize = 1): VoxelWorldPartRef {
  return {
    kind: "localBlob",
    key,
    encoding: "identity",
    byteSize,
    sha256: SHA,
  };
}

function texture() {
  return new THREE.Texture();
}

function assertFiniteBounds(actual: THREE.Box3, expected: THREE.Box3) {
  assert.deepEqual(actual.min.toArray(), expected.min.toArray());
  assert.deepEqual(actual.max.toArray(), expected.max.toArray());
}

function boxFor(object: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(object);
}

function meshDescendants(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

function lineBlocks(type: string): VoxelBlock[] {
  return Array.from({ length: 64 }, (_, x) => ({ x, y: 0, z: 0, type }));
}

async function createScene(delivery: VoxelWorldDelivery, opts?: Parameters<typeof createVoxelWorldScene>[3]) {
  return createVoxelWorldScene(delivery, getPalette("simple"), texture(), opts);
}

async function main() {
  {
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world",
      version: 1,
      gridSize: 8192,
      palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 3, z: 4 } },
      exactBlockCount: 24,
      leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
      source: source(),
      regions: [
        {
          kind: "uniform",
          key: "solid",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: 2, y: 3, z: 4 },
          type: "stone",
          blockCount: 24,
        },
      ],
    };
    const scene = await createScene({ manifest });

    assertFiniteBounds(
      scene.bounds.box,
      new THREE.Box3(new THREE.Vector3(-1, 0, -2), new THREE.Vector3(1, 3, 2)),
    );
    assert.equal(scene.stats.blockCount, 24);
    assert.deepEqual(scene.getResidentStats(), {
      residentRegions: 1,
      uniformRegions: 1,
      mixedDetailRegions: 0,
      mixedProxyRegions: 0,
      residentRegionPages: 0,
      loadingParts: 0,
    });

    const meshes = meshDescendants(scene.group);
    assert.equal(meshes.length, 1);
    const geometry = meshes[0].geometry;
    assert.equal(geometry.index?.count, 36);
    assert.equal(geometry.getAttribute("position").count, 24);
    assert.equal(geometry.getAttribute("atlasUvFrame").itemSize, 4);
    assert.equal(Math.max(...Array.from(geometry.getAttribute("uv").array)), 4);
    scene.dispose();
  }

  {
    const detailBytes = encodeBinaryVoxelBuild(lineBlocks("stone"), SHA);
    const farBytes = encodeBinaryVoxelBuild(lineBlocks("cobblestone"), SHA);
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world",
      version: 1,
      gridSize: 8192,
      palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 192, y: 1, z: 64 } },
      exactBlockCount: 128,
      leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
      source: source(),
      regions: [
        {
          kind: "mixed",
          key: "far",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: 64, y: 1, z: 1 },
          blockCount: 64,
          format: "mbv4",
          coordinateSpace: "local",
          data: localPart("far", farBytes.byteLength),
        },
        {
          kind: "mixed",
          key: "detail",
          origin: { x: 64, y: 0, z: 0 },
          size: { x: 64, y: 1, z: 1 },
          blockCount: 64,
          format: "mbv4",
          coordinateSpace: "local",
          data: localPart("detail", detailBytes.byteLength),
        },
      ],
    };
    const parts = new Map([
      ["detail", detailBytes],
      ["far", farBytes],
    ]);
    const scene = await createScene(
      { manifest, resolvePart: async (key) => parts.get(key) ?? new Uint8Array() },
      { maxMixedDetailRegions: 1, maxMixedProxyRegions: 0 },
    );

    assert.equal(scene.getResidentStats().mixedDetailRegions, 1);
    assert.equal(scene.getResidentStats().mixedProxyRegions, 0);
    assertFiniteBounds(
      boxFor(scene.group),
      new THREE.Box3(new THREE.Vector3(-32, 0, -32), new THREE.Vector3(32, 1, -31)),
    );
    scene.dispose();
  }

  {
    const pageRefs: VoxelWorldRegionPageRef[] = Array.from({ length: 4 }, (_, index) => ({
      index,
      bounds: { origin: { x: index * 64, y: 0, z: 0 }, size: { x: 64, y: 1, z: 64 } },
      regionCount: 1,
      blockCount: 64,
      data: localPart(`page-${index}`),
    }));
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world",
      version: 1,
      gridSize: 8192,
      palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 256, y: 1, z: 64 } },
      exactBlockCount: 256,
      leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
      source: source(),
      regionPages: pageRefs,
    };
    const pages = new Map<string, Uint8Array>();
    for (const ref of pageRefs) {
      const region: VoxelWorldRegion = {
        kind: "uniform",
        key: `page-${ref.index}-solid`,
        origin: ref.bounds.origin,
        size: { x: 64, y: 1, z: 1 },
        type: "stone",
        blockCount: 64,
      };
      const page: VoxelWorldRegionPage = {
        kind: "voxel_world_region_page",
        version: 1,
        index: ref.index,
        bounds: ref.bounds,
        regionCount: 1,
        blockCount: 64,
        regions: [region],
      };
      pages.set(ref.data.key, new TextEncoder().encode(JSON.stringify(page)));
    }

    const scene = await createScene(
      { manifest, resolvePart: async (key) => pages.get(key) ?? new Uint8Array() },
      { maxResidentPages: 2, maxMixedDetailRegions: 0, maxMixedProxyRegions: 0 },
    );
    await scene.loadAround(new THREE.Vector3(128, 0, 0));
    const stats = scene.getResidentStats();
    assert.equal(stats.residentRegionPages <= 2, true);
    assert.equal(stats.residentRegionPages < pageRefs.length, true);
    scene.dispose();
  }

  console.log("voxel world scene checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
