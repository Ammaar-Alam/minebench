import assert from "node:assert/strict";
import * as THREE from "three";
import {
  applyExplorerBlockLighting,
  createExplorerBlockLightGrid,
  getExplorerMeteorOpacity,
  getExplorerBlockLight,
  getExplorerWorldFogDistance,
  isExplorerSunRayVisible,
  renderExplorerBloomOverlay,
  setExplorerWorldFog,
} from "@/lib/voxel/explorerLighting";
import {
  packVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";

const openBuild: RenderableVoxelBuild = {
  version: "1.0",
  blocks: [
    { x: 0, y: 0, z: 0, type: "glowstone" },
    { x: 20, y: 0, z: 0, type: "glowstone" },
    { x: 1, y: 0, z: 0, type: "glass" },
  ],
};

async function main() {
  const open = await createExplorerBlockLightGrid(openBuild);
  assert.ok(open);
  assert.equal(getExplorerBlockLight(open, 0, 0, 0), 15);
  assert.equal(getExplorerBlockLight(open, 1, 0, 0), 14);
  assert.equal(getExplorerBlockLight(open, 2, 0, 0), 13);
  assert.equal(getExplorerBlockLight(open, 20, 0, 0), 15);

  const enclosure = await createExplorerBlockLightGrid({
    version: "1.0",
    blocks: [
      { x: 0, y: 0, z: 0, type: "glowstone" },
      { x: -1, y: 0, z: 0, type: "stone" },
      { x: 1, y: 0, z: 0, type: "stone" },
      { x: 0, y: -1, z: 0, type: "stone" },
      { x: 0, y: 1, z: 0, type: "stone" },
      { x: 0, y: 0, z: -1, type: "stone" },
      { x: 0, y: 0, z: 1, type: "stone" },
    ],
  });
  assert.ok(enclosure);
  assert.equal(getExplorerBlockLight(enclosure, 2, 0, 0), 0);

  const packed = await createExplorerBlockLightGrid({
    version: "1.0",
    blocks: [],
    packed: packVoxelBlocks(openBuild.blocks),
  });
  assert.ok(packed);
  assert.equal(getExplorerBlockLight(packed, 2, 0, 0), 13);

  assert.equal(
    await createExplorerBlockLightGrid({
      version: "1.0",
      blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
    }),
    null,
  );
  assert.equal(
    await createExplorerBlockLightGrid({
      version: "1.0",
      blocks: [
        { x: 0, y: 0, z: 0, type: "glowstone" },
        { x: 511, y: 511, z: 511, type: "glowstone" },
      ],
    }),
    null,
  );
  assert.equal(isExplorerSunRayVisible(0, 0, 0), true);
  assert.equal(isExplorerSunRayVisible(1.3, 0, 0), false);
  assert.equal(isExplorerSunRayVisible(0, 0, 2), false);
  assert.equal(getExplorerMeteorOpacity(0, 0, 1), 0);
  assert.equal(getExplorerMeteorOpacity(0.5, 0, 1), 1);
  assert.equal(getExplorerMeteorOpacity(1, 0, 1), 0);
  assert.equal(getExplorerMeteorOpacity(1, 0, 0), 0);

  const renderer = { autoClear: true };
  renderExplorerBloomOverlay(renderer, () => assert.equal(renderer.autoClear, false));
  assert.equal(renderer.autoClear, true);

  const sanFranciscoWorldFogDistance = getExplorerWorldFogDistance({ x: 8_162, z: 8_171 });
  assert.equal(sanFranciscoWorldFogDistance, 2_048, "large worlds cap the visible distance inside the city");
  assert.equal(getExplorerWorldFogDistance({ x: 512, z: 512 }), 1_024, "small worlds retain a generous foreground range");
  assert.equal(getExplorerWorldFogDistance({ x: 2_048, z: 1_024 }), 2_048 * 0.55);
  for (const aspect of [0.5, 16 / 9, 3]) {
    const camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 50_000);
    camera.zoom = 1.4;
    camera.updateProjectionMatrix();
    const fog = new THREE.Fog(0xaed4ef);
    const bloomFog = new THREE.Fog(0xffffff);
    setExplorerWorldFog(camera, fog, bloomFog, sanFranciscoWorldFogDistance);
    assert.ok(fog.near < fog.far);
    const emission = new THREE.Color(10, 8, 2).lerp(
      bloomFog.color,
      THREE.MathUtils.smoothstep(fog.far, bloomFog.near, bloomFog.far),
    );
    assert.deepEqual(emission.toArray(), [0, 0, 0], "bloom cannot reveal geometry beyond the fog");
    assert.equal(fog.far, sanFranciscoWorldFogDistance, "world fog uses the bounded viewing distance");
    assert.equal(fog.near, sanFranciscoWorldFogDistance * 0.2, "world fog begins before the mid-distance skyline");
    const twoKilometerFog = THREE.MathUtils.smoothstep(2_000, fog.near, fog.far);
    const fourKilometerFog = THREE.MathUtils.smoothstep(4_000, fog.near, fog.far);
    assert.ok(twoKilometerFog > 0.99, "geometry at 2km is almost fully obscured");
    assert.equal(fourKilometerFog, 1, "distant geometry is fully obscured");
    assert.ok(camera.far > fog.far, "the camera cannot clip scenery before the fog");
    assert.equal(camera.far, fog.far + 64, "only one region of fully fogged scenery remains beyond the fog");
    const frustum = new THREE.Frustum().setFromProjectionMatrix(camera.projectionMatrix);
    assert.equal(frustum.containsPoint(new THREE.Vector3(0, 0, -fog.far * 1.2)), false);
    assert.equal(frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(0, 0, -fog.far - 128), 32)), false);
    assert.equal(frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(0, 0, -3_000), 256)), false, "fog culls distant city batches even from the center");
    assert.equal(frustum.containsPoint(new THREE.Vector3(0, 0, -fog.far + 1)), true, "visible scenery remains inside the far plane");
    assert.equal(frustum.containsPoint(new THREE.Vector3(0, 0, -.06)), true, "nearby detail retains its near plane");
    assert.equal(frustum.containsPoint(new THREE.Vector3(0, 0, -.025)), false);
    assert.equal(camera.near, .05);
    assert.equal(bloomFog.near, fog.near);
    assert.equal(bloomFog.far, fog.far);
  }
  const clippedCamera = new THREE.PerspectiveCamera(70, 1, 300, 1000);
  setExplorerWorldFog(clippedCamera, new THREE.Fog(0), new THREE.Fog(0), 64);
  assert.equal(clippedCamera.far, 600, "the far plane cannot cross a larger near plane");
  assert.throws(() => renderExplorerBloomOverlay(renderer, () => { throw new Error("draw failed"); }));
  assert.equal(renderer.autoClear, true);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    2.5, -0.5, 0.5,
    3.5, -0.5, 0.5,
    3.5, 0.5, 0.5,
    2.5, 0.5, 0.5,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial());
  await applyExplorerBlockLighting(
    mesh,
    new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(20.5, 0.5, 0.5)),
    open,
  );
  assert.deepEqual(
    Array.from(mesh.geometry.getAttribute("explorerBlockLight").array),
    [187, 170, 187, 204],
  );
  geometry.dispose();
  mesh.material.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
