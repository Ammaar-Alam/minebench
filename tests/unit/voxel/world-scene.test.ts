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
    await scene.loadAround(scene.bounds.center);
    assert.equal(meshDescendants(scene.group)[0].geometry, geometry, "unchanged regions keep their geometry");
    scene.dispose();
  }

  {
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world", version: 1, gridSize: 8192, palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 1 } },
      exactBlockCount: 2, leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE, source: source(),
      regions: [0, 1].map((x) => ({
        kind: "uniform", key: `solid-${x}`, origin: { x, y: 0, z: 0 },
        size: { x: 1, y: 1, z: 1 }, type: "stone", blockCount: 1,
      })),
    };
    const scene = await createScene({ manifest }, { maxUniformRegions: 1 });
    assert.equal(meshDescendants(scene.group)[0].geometry.index?.count, 36, "unloaded neighbors cannot hide visible faces");
    assert.equal(scene.getDetailRadius(scene.bounds.center), 0, "unrendered uniform regions limit exact coverage");
    assert.equal(boxFor(scene.group).min.x, -1);
    await scene.loadAround(new THREE.Vector3(1, 0, 0));
    assert.equal(boxFor(scene.group).min.x, 0, "same-count region selection changes with focus");
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

    const withoutProxies = await createScene(
      { manifest, resolvePart: async (key) => parts.get(key) ?? new Uint8Array() },
      { maxMixedDetailRegions: 2, maxMixedProxyRegions: 0, mixedDetailRadius: 0 },
    );
    assert.equal(withoutProxies.getResidentStats().mixedDetailRegions, 1);
    assert.equal(withoutProxies.getResidentStats().mixedProxyRegions, 0, "unused detail slots cannot become proxies");
    withoutProxies.dispose();

    const moving = await createScene(
      { manifest, resolvePart: async (key) => parts.get(key) ?? new Uint8Array() },
      { maxMixedDetailRegions: 1, maxMixedProxyRegions: 1 },
    );
    await moving.loadAround(new THREE.Vector3(-96, 0, -32));
    assert.equal(moving.getResidentStats().mixedDetailRegions, 1, "distant details downgrade when focus moves");
    assert.equal(moving.getResidentStats().mixedProxyRegions, 1);
    moving.dispose();
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
    assert.ok(scene.getDetailRadius(scene.bounds.center) > 63 && scene.getDetailRadius(scene.bounds.center) < 64, "unloaded pages limit exact coverage");
    await scene.loadAround(new THREE.Vector3(128, 0, 0));
    const stats = scene.getResidentStats();
    assert.equal(stats.residentRegionPages <= 2, true);
    assert.equal(stats.residentRegionPages < pageRefs.length, true);
    scene.dispose();

    let activeReads = 0;
    let peakReads = 0;
    const allPages = await createScene({
      manifest,
      resolvePart: async (key) => {
        peakReads = Math.max(peakReads, ++activeReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeReads -= 1;
        return pages.get(key) ?? new Uint8Array();
      },
    }, { maxResidentPages: 4, maxMixedDetailRegions: 0, maxMixedProxyRegions: 0 });
    assert.ok(peakReads <= 2, `page reads must stay bounded, saw ${peakReads}`);
    allPages.dispose();
  }

  {
    const bytes = encodeBinaryVoxelBuild(lineBlocks("stone"), SHA);
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world", version: 1, gridSize: 8192, palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 512, y: 1, z: 1 } },
      exactBlockCount: 128, leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE, source: source(),
      regions: [0, 448].map((x) => ({
        kind: "mixed", key: `region-${x}`, origin: { x, y: 0, z: 0 },
        size: { x: 64, y: 1, z: 1 }, blockCount: 64, format: "mbv4", coordinateSpace: "local",
        data: localPart(`part-${x}`, bytes.byteLength),
      })),
    };
    const requested: string[] = [];
    const scene = await createScene({ manifest, resolvePart: async (key) => {
      requested.push(key);
      return bytes;
    } }, { initialFocus: new THREE.Vector3(256, 0, 0), maxMixedDetailRegions: 1, maxMixedProxyRegions: 0 });
    assert.deepEqual(requested, ["part-448"], "initial loading follows the player position");
    scene.dispose();

    let failures = 0;
    const controller = new AbortController();
    await assert.rejects(createScene({ manifest, resolvePart: async () => {
      failures += 1;
      throw new Error("missing world part");
    } }, { signal: controller.signal, maxMixedDetailRegions: 1, maxMixedProxyRegions: 0 }), /missing world part/);
    controller.abort();
    assert.equal(failures, 1, "failed parts must not start an endless retry loop");
  }

  {
    const bytes = encodeBinaryVoxelBuild([{ x: 4, y: 1, z: 2, type: "stone" }], SHA);
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world", version: 1, gridSize: 8192, palette: "simple",
      bounds: { origin: { x: 128, y: 32, z: 64 }, size: { x: 32, y: 32, z: 32 } },
      exactBlockCount: 32 ** 3, leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE, source: source(),
      overview: { scale: 32, data: localPart("overview", bytes.byteLength) },
      regions: [{ kind: "uniform", key: "solid", origin: { x: 128, y: 32, z: 64 }, size: { x: 32, y: 32, z: 32 }, type: "stone", blockCount: 32 ** 3 }],
    };
    const scene = await createScene({ manifest, resolvePart: async () => bytes }, { maxUniformRegions: 0 });
    const overview = scene.group.getObjectByName("VoxelWorldOverview");
    assert.ok(overview);
    assertFiniteBounds(boxFor(overview), new THREE.Box3(new THREE.Vector3(-16, 0, -16), new THREE.Vector3(16, 32, 16)));
    const mesh = meshDescendants(overview)[0];
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    assert.equal(material.allowOverride, false, "the overview keeps its clipping shader in depth passes");
    const passScene = new THREE.Scene();
    passScene.overrideMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
    material.onBeforeRender({} as THREE.WebGLRenderer, passScene, new THREE.Camera(), mesh.geometry, mesh, new THREE.Group());
    assert.equal(material.colorWrite, false);
    passScene.overrideMaterial.dispose();
    passScene.overrideMaterial = null;
    material.onBeforeRender({} as THREE.WebGLRenderer, passScene, new THREE.Camera(), mesh.geometry, mesh, new THREE.Group());
    assert.equal(material.colorWrite, true);
    scene.dispose();
    const detailed = await createScene({ manifest, resolvePart: async () => bytes });
    assert.equal(detailed.group.getObjectByName("VoxelWorldOverview")?.visible, false, "complete exact coverage hides the overview");
    detailed.dispose();
    const exact = await createScene({ manifest, resolvePart: async () => {
      throw new Error("overview must not enter an exact-only scene");
    } }, { showOverview: false, maxMixedProxyRegions: 0 });
    assert.equal(exact.group.getObjectByName("VoxelWorldOverview"), undefined);
    assert.equal(exact.getDetailRadius(exact.bounds.center), Infinity);
    exact.dispose();
  }

  {
    const bytes = encodeBinaryVoxelBuild([{ x: 0, y: 0, z: 0, type: "stone" }], SHA);
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world", version: 1, gridSize: 8192, palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 512, y: 64, z: 64 } },
      exactBlockCount: 2, leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE, source: source(),
      overview: { scale: 32, data: localPart("overview", bytes.byteLength) },
      regions: [0, 448].map((x) => ({
        kind: "mixed", key: `region-${x}`, origin: { x, y: 0, z: 0 },
        size: { x: 64, y: 64, z: 64 }, blockCount: 1, format: "mbv4", coordinateSpace: "local",
        data: localPart(`part-${x}`, bytes.byteLength),
      })),
    };
    let releaseDetail = () => {};
    const pendingDetail = new Promise<Uint8Array>((resolve) => { releaseDetail = () => resolve(bytes); });
    const focus = new THREE.Vector3(-240, 1, 0);
    const progress: Array<{ processedBlocks: number; totalBlocks: number; stageLabel?: string } | null> = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const scene = await Promise.race([
      createScene({ manifest, resolvePart: async (key) => key === "overview" ? bytes : pendingDetail }, {
        initialFocus: focus, maxMixedDetailRegions: 1, onProgress: (value) => progress.push(value),
      }),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("overview waited for distant detail")), 1000); }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(scene.getResidentStats().loadingParts, 1, "the overview is ready while exact detail is still loading");
    assert.ok(progress.at(-1), "loading stays visible while nearby detail is pending");
    const overview = scene.group.getObjectByName("VoxelWorldOverview");
    assert.ok(overview);
    const material = meshDescendants(overview)[0].material as THREE.Material;
    const shader = {
      uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    } as Parameters<THREE.Material["onBeforeCompile"]>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    assert.equal(shader.uniforms.worldDetailRadius.value, 0, "overview coverage remains until the exact region is ready");
    assert.match(shader.fragmentShader, /distance\(vWorldOverviewPosition, worldDetailFocus\) < worldDetailRadius\) discard/);
    releaseDetail();
    await scene.loadAround(focus);
    assert.equal(progress.at(-1), null, "loading finishes when requested detail is ready");
    assert.ok(shader.uniforms.worldDetailRadius.value > 431 && shader.uniforms.worldDetailRadius.value < 432);
    assert.deepEqual(shader.uniforms.worldDetailFocus.value.toArray(), focus.toArray());
    assert.equal(overview.visible, true, "distant unavailable regions keep their overview");
    assert.equal(scene.getDetailRadius(focus), shader.uniforms.worldDetailRadius.value);
    assert.equal(scene.getDetailRadius(focus.clone().addScalar(10)), shader.uniforms.worldDetailRadius.value - Math.sqrt(300));
    const movedFocus = new THREE.Vector3(240, 1, 0);
    const moving = scene.loadAround(movedFocus);
    assert.equal(shader.uniforms.worldDetailRadius.value, 0, "moving restores overview coverage while detail loads");
    await moving;
    assert.equal(scene.getResidentStats().mixedDetailRegions, 1);
    assert.ok(shader.uniforms.worldDetailRadius.value > 431 && shader.uniforms.worldDetailRadius.value < 432);
    assert.deepEqual(shader.uniforms.worldDetailFocus.value.toArray(), movedFocus.toArray());
    scene.dispose();
    const exact = await createScene({ manifest, resolvePart: async (key) => {
      assert.notEqual(key, "overview", "exact-only scenes never download coarse geometry");
      return bytes;
    } }, { initialFocus: focus, showOverview: false, maxMixedDetailRegions: 1, maxMixedProxyRegions: 0 });
    assert.equal(exact.group.getObjectByName("VoxelWorldOverview"), undefined);
    assert.ok(exact.getDetailRadius(focus) > 431, "initial detail is ready before Explore returns");
    const exactMove = exact.loadAround(movedFocus);
    assert.equal(exact.group.getObjectByName("VoxelWorldOverview"), undefined, "moving cannot restore coarse geometry");
    assert.equal(exact.getDetailRadius(movedFocus), 0);
    await exactMove;
    assert.ok(exact.getDetailRadius(movedFocus) > 431);
    exact.dispose();
    const errors: string[] = [];
    const failed = await createScene({
      manifest,
      resolvePart: async (key) => {
        if (key === "overview") return bytes;
        throw new Error("nearby detail failed");
      },
    }, { initialFocus: focus, maxMixedDetailRegions: 1, onError: (message) => errors.push(message) });
    await assert.rejects(failed.loadAround(focus), /nearby detail failed/);
    assert.deepEqual(errors, ["nearby detail failed"]);
    failed.dispose();
  }

  console.log("voxel world scene checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
