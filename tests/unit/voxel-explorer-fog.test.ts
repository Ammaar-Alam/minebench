import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import { enableExplorerFog, enableExplorerSkyGradient } from "@/lib/voxel/explorerFog";
import { enableExplorerShadows } from "@/lib/voxel/explorerShadows";
import { configureWorldQuadMesh, createWorldQuadGeometry } from "@/lib/voxel/worldQuadGeometry";

function compile(material: THREE.Material, kind: "lambert" | "basic") {
  const source = THREE.ShaderLib[kind];
  const shader = { ...source, uniforms: THREE.UniformsUtils.clone(source.uniforms) };
  material.onBeforeCompile(shader as Parameters<THREE.Material["onBeforeCompile"]>[0], {} as THREE.WebGLRenderer);
  return shader;
}

function skyUv(source: string) {
  const body = source.match(/vec2 explorerSkyUv\(\) \{([^}]+)\}/)![1];
  return runInNewContext(`(vExplorerViewRay) => { ${body} }`, {
    vec2: (x: number, y: number) => [x, y],
    normalize: (ray: THREE.Vector3) => ray.clone().normalize(),
    acos: Math.acos,
    clamp: THREE.MathUtils.clamp,
    PI: Math.PI,
  }) as (ray: THREE.Vector3) => number[];
}

const day = new THREE.Texture();
const night = new THREE.Texture();
const uniforms = {
  explorerDaySky: { value: day },
  explorerNightSky: { value: night },
  explorerNightBlend: { value: 0 },
};
const sky = new THREE.MeshBasicMaterial({ map: day, toneMapped: false });
enableExplorerSkyGradient(sky);
const skyShader = compile(sky, "basic");
const skyUvAt = skyUv(skyShader.fragmentShader);
assert.match(skyShader.fragmentShader, /diffuseColor \*= texture2D\(map, explorerSkyUv\(\)\)/);

for (const kind of ["lambert", "basic"] as const) {
  for (const water of [false, true]) {
    const material = kind === "lambert"
      ? new THREE.MeshLambertMaterial({ map: day, transparent: water })
      : new THREE.MeshBasicMaterial({ map: day });
    const bounds = { box: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(2, 3, 4)), center: new THREE.Vector3(1, 1.5, 2), radius: 3 };
    const geometry = createWorldQuadGeometry(new Uint32Array([0, 2 | (3 << 10) | (4 << 20), 0, 1020]), bounds)!;
    const mesh = new THREE.Mesh(geometry, material);
    configureWorldQuadMesh(mesh, [1, 0, 2], water);
    const key = material.customProgramCacheKey();
    enableExplorerFog(material, uniforms);
    if (kind === "lambert") enableExplorerShadows(material);
    const shader = compile(material, kind);
    assert.ok(material.customProgramCacheKey().startsWith(key));
    assert.match(shader.vertexShader, /transformed = worldQuadPosition - worldQuadAnchor/);
    assert.match(shader.vertexShader, /vExplorerViewRay = mvPosition.xyz \* mat3\(viewMatrix\)/);
    assert.match(shader.fragmentShader, /smoothstep\( fogNear, fogFar, length\(vExplorerViewRay\) \)/);
    assert.match(shader.fragmentShader, /#ifdef USE_FOG/, "Fog off keeps the native shader switch");
    assert.match(shader.fragmentShader, /fogFactor > 0.0 && any\(greaterThan\(fogColor, vec3\(0.0\)\)\)/, "black bloom fog must not add sky emission");
    assert.match(shader.fragmentShader, /linearToOutputTexel\(texture2D\(explorerDaySky, skyUv\)\)/);
    assert.match(shader.fragmentShader, /linearToOutputTexel\(texture2D\(explorerNightSky, skyUv\)\)/);
    assert.match(shader.fragmentShader, /mix\(day, night, explorerNightBlend\)/, "day and night blend in the same output space as the sky layers");
    assert.equal(shader.uniforms.explorerDaySky.value, day);
    assert.equal(shader.uniforms.explorerNightSky.value, night);
    const fogUvAt = skyUv(shader.fragmentShader);
    for (const direction of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, .7, 2)]) {
      const fogUv = fogUvAt(direction);
      assert.deepEqual(fogUv, skyUvAt(direction), "fully fogged geometry samples the same sky pixel at every angle");
      assert.ok(fogUv[1] >= 0 && fogUv[1] <= 1);
      const distance = 2_048;
      const point = direction.clone().normalize().multiplyScalar(distance);
      for (const yaw of [0, Math.PI / 3, Math.PI]) {
        const camera = new THREE.PerspectiveCamera();
        camera.rotation.set(.3, yaw, -.08);
        camera.updateMatrixWorld();
        const viewRay = point.clone().applyMatrix4(camera.matrixWorldInverse);
        const worldRay = viewRay.applyMatrix3(new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse).transpose());
        assert.ok(Math.abs(worldRay.length() - distance) < 1e-9, "radial fog does not move with the camera's viewing direction");
        const rotatedUv = fogUvAt(worldRay);
        assert.ok(Math.abs(rotatedUv[1] - fogUv[1]) < 1e-8);
        assert.equal(THREE.MathUtils.smoothstep(worldRay.length(), 409.6, 2_047), 1);
      }
    }
    uniforms.explorerNightBlend.value = .5;
    assert.equal(shader.uniforms.explorerNightBlend.value, .5, "day-night changes reach an already compiled shader");
    geometry.dispose();
    material.dispose();
  }
}
assert.deepEqual(skyUvAt(new THREE.Vector3(0, 1, 0)), [.5, 1]);
assert.deepEqual(skyUvAt(new THREE.Vector3(0, -1, 0)), [.5, 0]);
sky.dispose();
day.dispose();
night.dispose();
console.log("voxel explorer fog checks passed");
