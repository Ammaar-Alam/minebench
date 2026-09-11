import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { getPalette } from "../../../lib/blocks/palettes";
import { DIRS } from "../../../lib/voxel/ambientOcclusion";
import { decodeBinaryVoxelBuild, encodeBinaryVoxelBuild } from "../../../lib/voxel/binaryBuild";
import { buildMeshPayload } from "../../../lib/voxel/mesh.worker";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { createVoxelWorldScene, isVoxelWorldScene } from "../../../lib/voxel/worldScene";
import { encodeWorldMeshPayload, getWorldMeshVersion } from "../../../lib/voxel/worldMesh";
import { buildWorldRegionGreedyMeshPayload } from "../../../lib/voxel/worldRegionMesh";
import { buildWorldMeshPayloads } from "../../../lib/voxel/worldMeshSource";
import { WORLD_QUAD_COLORS, WORLD_QUAD_TINT_GRASS, WORLD_QUAD_TINT_WHITE, WORLD_QUAD_TINTS } from "../../../lib/voxel/worldQuadData";
import type {
  VoxelWorldDelivery,
  VoxelWorldManifest,
  VoxelWorldPartRef,
  VoxelWorldRegionPage,
  VoxelWorldRegionPageRef,
  VoxelWorldRegion,
} from "../../../lib/voxel/world";

const SHA = "a".repeat(64);
const BASE = {
  kind: "voxel_world", version: 1, gridSize: 8192, palette: "simple", leafSize: 64,
  source: { format: "build_json", sha256: SHA, evaluatorVersion: 1 },
} as const;

function localPart(key: string): VoxelWorldPartRef {
  return { kind: "localBlob", key, encoding: "identity", byteSize: 1, sha256: SHA };
}

function meshes(object: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  object.traverse((child) => { if (child instanceof THREE.Mesh) result.push(child); });
  return result;
}

function geometryHash(object: THREE.Object3D): string {
  const hash = createHash("sha256");
  for (const mesh of meshes(object)) {
    const attributes = [...Object.entries(mesh.geometry.attributes).sort(([a], [b]) => a.localeCompare(b)),
      ["index", mesh.geometry.index!]] as [string, THREE.BufferAttribute][];
    for (const [name, attribute] of attributes) {
      hash.update(JSON.stringify([name, attribute.array.constructor.name, attribute.itemSize, attribute.normalized]));
      hash.update(Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
    }
  }
  return hash.digest("hex");
}

function createScene(delivery: VoxelWorldDelivery, opts?: Parameters<typeof createVoxelWorldScene>[3]) {
  return createVoxelWorldScene(delivery, getPalette("simple"), new THREE.Texture(), opts);
}

async function main() {
  {
    const blocks = packVoxelBlocks([{ x: 0, y: 0, z: 0, type: "grass_block" }]);
    const allowed = getPalette("simple").map((block) => block.id);
    const legacy = buildMeshPayload(blocks, allowed).opaque!;
    const compact = buildWorldRegionGreedyMeshPayload(blocks, allowed, { size: { x: 1, y: 1, z: 1 } }).worldQuads!.opaque!;
    const scene = await createScene({ manifest: {
      ...BASE, exactBlockCount: 1,
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      regions: [{ kind: "uniform", key: "grass", origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, type: "grass_block", blockCount: 1 }],
    }, resolvePart: async () => { throw new Error("uniform grass requires no source read"); } });
    try {
      const geometry = meshes(scene.group)[0].geometry;
      const grassColor = WORLD_QUAD_TINTS[WORLD_QUAD_TINT_GRASS].map((channel) => Math.round(channel * 255));
      assert.equal(geometry.index?.count, 36);
      assert.equal(legacy.indices.length, 36);
      assert.equal(compact.length, 6 * 4);
      for (let vertex = 0; vertex < geometry.getAttribute("position").count; vertex += 1) {
        assert.deepEqual(Array.from(geometry.getAttribute("color").array.slice(vertex * 3, vertex * 3 + 3)),
          geometry.getAttribute("normal").getY(vertex) === 1 ? grassColor : [255, 255, 255], "uniform grass tints only its top face");
        assert.deepEqual(Array.from(legacy.colors.subarray(vertex * 3, vertex * 3 + 3)),
          legacy.normals[vertex * 3 + 1] === 127 ? grassColor : [255, 255, 255], "legacy grass keeps the same top and side colors");
      }
      for (let offset = 0; offset < compact.length; offset += 4) {
        const face = DIRS[(compact[offset + 1] >>> 20) & 7].face;
        assert.equal(compact[offset + 3] & 3, face === "up" ? WORLD_QUAD_TINT_GRASS : WORLD_QUAD_TINT_WHITE);
        assert.equal((compact[offset + 3] >>> 2) & 255, 255, "isolated grass has no ambient occlusion");
        assert.equal(compact[offset + 1] & 1023, 1);
        assert.equal((compact[offset + 1] >>> 10) & 1023, 1);
      }
    } finally { scene.dispose(); }
  }

  {
    const manifest: VoxelWorldManifest = {
      ...BASE,
      bounds: { origin: { x: 128, y: 32, z: 64 }, size: { x: 2, y: 3, z: 4 } },
      exactBlockCount: 24,
      overview: { scale: 32, data: localPart("overview") },
      regions: [{
        kind: "uniform", key: "solid", origin: { x: 128, y: 32, z: 64 },
        size: { x: 2, y: 3, z: 4 }, type: "stone", blockCount: 24,
      }],
    };
    const scene = await createScene({ manifest, resolvePart: async () => {
      throw new Error("coarse overview must never load");
    } });
    assert.ok(isVoxelWorldScene(scene));
    assert.deepEqual(scene.bounds.box.min.toArray(), [-1, 0, -2]);
    assert.deepEqual(scene.bounds.box.max.toArray(), [1, 3, 2]);
    assert.deepEqual(new THREE.Box3().setFromObject(scene.group), scene.bounds.box);
    assert.equal(scene.stats.blockCount, 24);
    assert.deepEqual(scene.getResidentStats(), {
      residentRegions: 1, uniformRegions: 1, mixedRegions: 0, residentRegionPages: 0, meshBatches: 0,
    });
    const geometry = meshes(scene.group)[0].geometry;
    assert.equal(geometry.index?.count, 36);
    assert.equal(geometry.getAttribute("position").count, 24);
    assert.equal(geometry.getAttribute("atlasUvFrame").itemSize, 4);
    assert.equal(Math.max(...geometry.getAttribute("uv").array), 4);
    const uv = geometry.getAttribute("uv");
    for (let base = 0; base < 24; base += 4) for (let corner = 0; corner < 4; corner += 1) {
      const current = base + corner;
      const next = base + (corner + 1) % 4;
      assert.equal(
        new THREE.Vector2(uv.getX(current), uv.getY(current))
          .distanceTo(new THREE.Vector2(uv.getX(next), uv.getY(next))),
        new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), current)
          .distanceTo(new THREE.Vector3().fromBufferAttribute(geometry.getAttribute("position"), next)),
        "uniform face edges repeat the texture once per block",
      );
    }
    scene.dispose();
    scene.dispose();
    assert.equal(scene.group.children.length, 0);
    assert.equal(scene.getResidentStats().residentRegions, 0);
  }

  {
    const source = encodeBinaryVoxelBuild([
      { x: 0, y: 0, z: 0, type: "water" }, { x: 0, y: 0, z: 1, type: "water" },
      { x: 1, y: 0, z: 0, type: "water" }, { x: 1, y: 0, z: 1, type: "stone" },
    ], SHA);
    const regions: VoxelWorldRegion[] = [
      ...[0, 2].map((x) => ({
        kind: "uniform" as const, key: `water-${x}`, origin: { x, y: 0, z: 0 },
        size: { x: 2, y: 1, z: 2 }, type: "water", blockCount: 4,
      })),
      { kind: "uniform", key: "shore", origin: { x: 0, y: 0, z: 2 }, size: { x: 1, y: 1, z: 1 }, type: "stone", blockCount: 1 },
      { kind: "uniform", key: "glass", origin: { x: 2, y: 0, z: 2 }, size: { x: 2, y: 1, z: 1 }, type: "glass", blockCount: 2 },
      { kind: "mixed", key: "boat", origin: { x: 4, y: 0, z: 0 }, size: { x: 2, y: 1, z: 2 }, blockCount: 4,
        format: "mbv4", coordinateSpace: "local", data: localPart("source") },
    ];
    const meshParts = new Map<string, Uint8Array>();
    const batches = [];
    for await (const batch of buildWorldMeshPayloads({ regions, sourceBuildSha256: SHA,
      paletteIds: ["water", "stone", "glass"], readPart: async () => source })) {
      const key: string = `mesh-${batches.length}`;
      meshParts.set(key, encodeWorldMeshPayload(batch.payload));
      batches.push({ bounds: batch.bounds, blockCount: batch.blockCount, data: localPart(key) });
    }
    const manifest: VoxelWorldManifest = {
      ...BASE, bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 6, y: 1, z: 3 } },
      exactBlockCount: 15, regions, mesh: { version: await getWorldMeshVersion(), batches },
    };
    const scene = await createScene({ manifest, resolvePart: async (key) => {
      assert.ok(meshParts.has(key), "prepared water does not read source parts");
      return meshParts.get(key)!;
    } });
    try {
      const uniformMeshes = meshes(scene.group.getObjectByName("VoxelWorldUniformRegions")!);
      const uniform = uniformMeshes.find((mesh) => mesh.geometry.getAttribute("color").getX(0) !== 1)!;
      const mixed = meshes(scene.group.getObjectByName("VoxelWorldMeshBatch")!)
        .find((mesh) => mesh.renderOrder === 1)!;
      const uniformMaterial = uniform.material as THREE.MeshLambertMaterial;
      const mixedMaterial = mixed.material as THREE.MeshLambertMaterial;
      assert.equal(uniformMaterial.opacity, mixedMaterial.opacity, "water opacity cannot depend on region kind");
      assert.equal(uniformMaterial.side, mixedMaterial.side, "water face policy cannot depend on region kind");
      assert.equal(uniformMaterial.map, mixedMaterial.map, "water uses its dedicated texture in both paths");
      assert.equal(uniformMaterial.emissive.getHex(), mixedMaterial.emissive.getHex());
      assert.equal(uniformMaterial.emissiveIntensity, mixedMaterial.emissiveIntensity);
      const colors = uniform.geometry.getAttribute("color");
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(Math.abs(colors.getComponent(0, channel) - WORLD_QUAD_COLORS[45 + channel]) < 1e-6,
          "uniform water retains the mixed mesh's linear tint");
      }
      assert.equal(uniformMeshes.filter((mesh) => (mesh.material as THREE.MeshLambertMaterial).opacity === 0.85).length, 1,
        "glass keeps its own transparent material");
      const positions = uniform.geometry.getAttribute("position");
      const normals = uniform.geometry.getAttribute("normal");
      let internalFaces = 0;
      let shorelineFaces = 0;
      for (let vertex = 0; vertex < positions.count; vertex += 4) {
        if (Math.abs(normals.getX(vertex)) === 1 && positions.getX(vertex) === -1) internalFaces += 1;
        if (normals.getZ(vertex) === 1 && positions.getZ(vertex) === 0.5) shorelineFaces += 1;
      }
      assert.equal(internalFaces, 0, "fully adjacent uniform water emits no internal faces");
      assert.equal(shorelineFaces, 2, "partial shoreline coverage and different transparent neighbors retain exposed water faces");
      assert.equal(geometryHash(scene.group.getObjectByName("VoxelWorldUniformRegions")!),
        "3105a2c6802e9577d45328cb954aa99ba3df07402169579daf3c7ae735e0367e",
        "water and partial shoreline geometry remain byte-identical");
    } finally {
      scene.dispose();
    }
  }

  {
    const regions = [
      { origin: { x: 6, y: 8, z: 8 }, size: { x: 2, y: 4, z: 4 }, type: "glass" },
      { origin: { x: 12, y: 7, z: 7 }, size: { x: 2, y: 6, z: 6 }, type: "stone" },
      { origin: { x: 8, y: 12, z: 8 }, size: { x: 4, y: 2, z: 2 }, type: "stone" },
      { origin: { x: 8, y: 6, z: 8 }, size: { x: 4, y: 2, z: 4 }, type: "glowstone" },
      { origin: { x: 8, y: 8, z: 6 }, size: { x: 4, y: 4, z: 2 }, type: "water" },
      { origin: { x: 20, y: 8, z: 12 }, size: { x: 4, y: 4, z: 2 }, type: "stone" },
      { origin: { x: 30, y: 8, z: 8 }, size: { x: 4, y: 1, z: 4 }, type: "water" },
      { origin: { x: 34, y: 8, z: 8 }, size: { x: 4, y: 1, z: 4 }, type: "water" },
      { origin: { x: 8, y: 8, z: 8 }, size: { x: 4, y: 4, z: 4 }, type: "stone" },
    ].map((region, index) => ({ ...region, kind: "uniform" as const, key: `region-${index}`,
      blockCount: region.size.x * region.size.y * region.size.z }));
    const scene = await createScene({ manifest: {
      ...BASE, bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 41, y: 21, z: 21 } },
      exactBlockCount: regions.reduce((total, region) => total + region.blockCount, 0), regions,
    }, resolvePart: async () => { throw new Error("uniform geometry must not read source parts"); } });
    try {
      assert.equal(geometryHash(scene.group), "1e1b5b24dc436e08c0e360be196b8947a91d0c67d370bf312d2b0cdfba49a769",
        "uneven neighbors, disjoint faces, and material boundaries retain geometry and order");
    } finally {
      scene.dispose();
    }
  }

  {
    const floor = Array.from({ length: 64 * 64 }, (_, index) => ({
      x: index % 64, y: 0, z: Math.floor(index / 64), type: index === 0 ? "bricks" : "stone",
    })).filter((block) => block.x !== 1 || block.z !== 0);
    const bytes = encodeBinaryVoxelBuild(floor, SHA);
    const manifest: VoxelWorldManifest = {
      ...BASE,
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 2048, y: 1, z: 64 } },
      exactBlockCount: 32 * floor.length,
      overview: { scale: 32, data: localPart("overview") },
      regions: Array.from({ length: 32 }, (_, index) => ({
        kind: "mixed", key: `floor-${index}`, origin: { x: index * 64, y: 0, z: 0 },
        size: { x: 64, y: 1, z: 64 }, blockCount: floor.length, format: "mbv4", coordinateSpace: "local",
        data: localPart(`floor-${index}`),
      })),
    };
    const requested: string[] = [];
    const progress: Array<{ processedBlocks: number; totalBlocks: number } | null> = [];
    const scene = await createScene({ manifest, resolvePart: async (key) => {
      assert.notEqual(key, "overview");
      requested.push(key);
      return bytes;
    } }, { onProgress: (value) => progress.push(value) });
    assert.equal(scene.getResidentStats().mixedRegions, 32, "all source regions are ready together");
    assert.equal(scene.getResidentStats().meshBatches, 4);
    assert.equal(new Set(requested).size, 32);
    assert.deepEqual(new THREE.Box3().setFromObject(scene.group), scene.bounds.box);
    assert.equal(progress.at(-1), null);
    assert.equal(progress.at(-2)?.processedBlocks, manifest.exactBlockCount);
    assert.ok(progress.filter((value) => value !== null).every((value) => value.totalBlocks === manifest.exactBlockCount));
    const geometry = meshes(scene.group);
    assert.ok(geometry.length <= 20, "regions share spatial material batches");
    assert.ok(geometry.reduce((sum, mesh) => sum + mesh.geometry.userData.worldQuadCount, 0) < 3000,
      "coplanar surfaces merge without replacing source blocks");
    const covered = new Uint8Array(2048 * 64);
    for (const mesh of geometry) {
      assert.deepEqual(mesh.getWorldScale(new THREE.Vector3()).toArray(), [1, 1, 1]);
      assert.equal(mesh.frustumCulled, true);
      const texture = mesh.geometry.userData.worldQuadTexture as THREE.DataTexture;
      const count = mesh.geometry.userData.worldQuadCount as number;
      const words = new THREE.BufferAttribute((texture.image.data as Uint32Array).subarray(0, count * 4), 4);
      assert.equal(words.itemSize, 4);
      assert.equal(words.array.byteLength, words.count * 16);
      const shader = {
        vertexShader: THREE.ShaderLib.lambert.vertexShader,
        fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
        uniforms: {},
      } as Parameters<THREE.Material["onBeforeCompile"]>[0];
      (mesh.material as THREE.Material).onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      const anchor = shader.uniforms.worldQuadAnchor.value as THREE.Vector3;
      const offset = mesh.getWorldPosition(new THREE.Vector3()).sub(anchor).add(new THREE.Vector3(1024, 0, 32));
      for (let index = 0; index < words.count; index += 1) {
        const coordinates = words.getX(index);
        const dimensions = words.getY(index);
        if (((dimensions >>> 20) & 7) !== 4) continue;
        assert.equal((coordinates & 1023) + offset.y, 1, "all floors retain unit height");
        const x0 = ((coordinates >>> 10) & 1023) + offset.x;
        const z0 = ((coordinates >>> 20) & 1023) + offset.z;
        const width = dimensions & 1023;
        const height = (dimensions >>> 10) & 1023;
        assert.ok(x0 >= 0 && x0 + width <= 2048 && z0 >= 0 && z0 + height <= 64);
        for (let z = z0; z < z0 + height; z += 1) {
          for (let x = x0; x < x0 + width; x += 1) covered[z * 2048 + x] += 1;
        }
      }
    }
    for (let z = 0; z < 64; z += 1) {
      for (let x = 0; x < 2048; x += 1) {
        assert.equal(covered[z * 2048 + x], x % 64 === 1 && z === 0 ? 0 : 1,
          "every source floor cell renders once and every hole stays empty");
      }
    }
    const readCount = requested.length;
    for (const rotation of [0, Math.PI / 2, Math.PI]) {
      scene.group.rotation.y = rotation;
      scene.group.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(scene.group).getSize(new THREE.Vector3());
      assert.equal(size.y, 1);
      assert.ok(Math.abs(Math.hypot(size.x, size.z) - Math.hypot(2048, 64)) < 1e-6);
    }
    assert.equal(requested.length, readCount, "rotating a complete scene cannot reload geometry");
    assert.deepEqual(meshes(scene.group), geometry, "view changes keep the same complete geometry");
    assert.equal(scene.group.getObjectByName("VoxelWorldOverview"), undefined);
    scene.dispose();
  }

  {
    const bytes = encodeBinaryVoxelBuild([{ x: 0, y: 0, z: 0, type: "stone" }], SHA);
    const size = { x: 1, y: 1, z: 1 };
    const payload = buildWorldRegionGreedyMeshPayload(decodeBinaryVoxelBuild(bytes), ["stone"], { size });
    const meshBytes = encodeWorldMeshPayload(payload);
    const regions = Array.from({ length: 6 }, (_, index) => ({
      kind: "mixed" as const, key: `source-${index}`, origin: { x: index * 1024, y: 7, z: 13 }, size,
      blockCount: 1, format: "mbv4" as const, coordinateSpace: "local" as const, data: localPart(`source-${index}`),
    }));
    const manifest: VoxelWorldManifest = {
      ...BASE, bounds: { origin: { x: 0, y: 7, z: 13 }, size: { x: 5121, y: 1, z: 1 } },
      exactBlockCount: 6, regions,
      mesh: { version: await getWorldMeshVersion(), batches: regions.map((region, index) => ({
        bounds: { origin: region.origin, size }, blockCount: 1, data: localPart(`mesh-${index}`),
      })) },
    };
    const requested: string[] = [];
    let active = 0;
    let peak = 0;
    const previousWorker = globalThis.Worker;
    let workerCalls = 0;
    globalThis.Worker = class { constructor() { workerCalls += 1; throw new Error("unexpected mesh worker"); } } as unknown as typeof Worker;
    try {
      const scene = await createScene({ manifest, resolvePart: async (key) => {
        assert.ok(key.startsWith("mesh-"), "prepared geometry never downloads source cells");
        requested.push(key);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return meshBytes;
      } });
      assert.equal(workerCalls, 0, "saved worlds do not repeat meshing");
      assert.equal(peak, 4, "ready geometry downloads use bounded concurrency");
      assert.equal(requested.length, 6);
      assert.equal(scene.getResidentStats().mixedRegions, 6);
      assert.deepEqual(new THREE.Box3().setFromObject(scene.group), scene.bounds.box);
      assert.equal(meshes(scene.group).reduce((sum, mesh) => sum + mesh.geometry.userData.worldQuadCount, 0), 36);
      scene.dispose();
    } finally {
      globalThis.Worker = previousWorker;
    }
    await assert.rejects(createScene({ manifest: {
      ...manifest, mesh: { ...manifest.mesh!, batches: manifest.mesh!.batches.map((batch, index) =>
        index === 0 ? { ...batch, bounds: { ...batch.bounds, origin: { x: 1, y: 7, z: 13 } } } : batch,
      ) },
    }, resolvePart: async () => meshBytes }), /do not match source regions/);
    requested.length = 0;
    const fallback = await createScene({ manifest: { ...manifest, mesh: { ...manifest.mesh!, version: `v0-${SHA}` } }, resolvePart: async (key) => {
      assert.ok(key.startsWith("source-"), "old renderer artifacts use exact source fallback");
      requested.push(key);
      return bytes;
    } });
    assert.equal(new Set(requested).size, 6);
    assert.deepEqual(new THREE.Box3().setFromObject(fallback.group), fallback.bounds.box);
    fallback.dispose();
  }

  {
    const pageRefs: VoxelWorldRegionPageRef[] = Array.from({ length: 9 }, (_, index) => ({
      index, bounds: { origin: { x: index * 33, y: 0, z: 0 }, size: { x: 33, y: 1, z: 1 } },
      regionCount: 33, blockCount: 33, data: localPart(`page-${index}`),
    }));
    const manifest: VoxelWorldManifest = {
      ...BASE, bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 297, y: 1, z: 1 } },
      exactBlockCount: 297, regionPages: pageRefs,
      mesh: { version: await getWorldMeshVersion(), batches: [] },
    };
    const pages = new Map<string, Uint8Array>();
    for (const ref of pageRefs) {
      const page: VoxelWorldRegionPage = {
        kind: "voxel_world_region_page", version: 1, index: ref.index, bounds: ref.bounds,
        regionCount: 33, blockCount: 33,
        regions: Array.from({ length: 33 }, (_, index) => ({
          kind: "uniform", key: `solid-${ref.index * 33 + index}`,
          origin: { x: ref.index * 33 + index, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
          type: "stone", blockCount: 1,
        })),
      };
      pages.set(ref.data.key, new TextEncoder().encode(JSON.stringify(page)));
    }
    let activeReads = 0;
    let peakReads = 0;
    const requested: string[] = [];
    const scene = await createScene({ manifest, resolvePart: async (key) => {
      peakReads = Math.max(peakReads, ++activeReads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeReads -= 1;
      requested.push(key);
      return pages.get(key)!;
    } });
    assert.equal(peakReads, 2, "part reads remain bounded");
    assert.equal(requested.length, 9);
    assert.equal(scene.getResidentStats().residentRegionPages, 9);
    assert.equal(scene.getResidentStats().uniformRegions, 297, "uniform coverage has no region budget");
    assert.deepEqual(new THREE.Box3().setFromObject(scene.group), scene.bounds.box);
    assert.equal(meshes(scene.group)[0].geometry.index?.count, (297 * 4 + 2) * 6,
      "adjacent uniform regions do not emit shared faces");
    scene.dispose();
  }

  {
    const bytes = encodeBinaryVoxelBuild([{ x: 0, y: 0, z: 0, type: "stone" }], SHA);
    const manifest: VoxelWorldManifest = {
      ...BASE, bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1025, y: 1, z: 1 } },
      exactBlockCount: 3,
      regions: [
        { kind: "uniform", key: "solid", origin: { x: 512, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, type: "stone", blockCount: 1 },
        ...[0, 1024].map((x) => ({
          kind: "mixed" as const, key: `region-${x}`, origin: { x, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
          blockCount: 1, format: "mbv4" as const, coordinateSpace: "local" as const, data: localPart(`part-${x}`),
        })),
      ],
    };
    let disposedGeometry = 0;
    let readSignal: AbortSignal | undefined;
    let failedReads = 0;
    const allocated = new Set<THREE.BufferGeometry>();
    const originalAttribute = THREE.BufferGeometry.prototype.setAttribute;
    const originalDispose = THREE.BufferGeometry.prototype.dispose;
    THREE.BufferGeometry.prototype.setAttribute = function (name, attribute) {
      allocated.add(this);
      return originalAttribute.call(this, name, attribute);
    };
    THREE.BufferGeometry.prototype.dispose = function () {
      allocated.delete(this);
      disposedGeometry += 1;
      originalDispose.call(this);
    };
    try {
      await assert.rejects(createScene({ manifest, resolvePart: async (key, signal) => {
        readSignal = signal;
        if (key === "part-1024") { failedReads += 1; throw new Error("missing world part"); }
        return bytes;
      } }), /missing world part/);
      assert.ok(disposedGeometry >= 2, "failed startup disposes completed geometry");
      assert.equal(readSignal?.aborted, true, "failed startup cancels outstanding work");
      assert.equal(failedReads, 1, "failed parts do not retry forever");
      for (const abortAt of ["start", "complete"]) {
        const progressAbort = new AbortController();
        await assert.rejects(createScene({ manifest, resolvePart: async () => bytes }, {
          signal: progressAbort.signal,
          onProgress(value) {
            if (abortAt === "start" || value === null) progressAbort.abort();
          },
        }), { name: "AbortError" });
        assert.equal(allocated.size, 0, "progress cancellation cannot leak geometry or report success");
      }
    } finally {
      THREE.BufferGeometry.prototype.setAttribute = originalAttribute;
      THREE.BufferGeometry.prototype.dispose = originalDispose;
    }
    const controller = new AbortController();
    await assert.rejects(createScene({ manifest, resolvePart: async () => {
      controller.abort();
      return bytes;
    } }, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(createScene({ manifest, resolvePart: async () => encodeBinaryVoxelBuild([], SHA) }), /block count mismatch/);
  }
  console.log("voxel world scene checks passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
