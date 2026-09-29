import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import { enableExplorerShadows } from "@/lib/voxel/explorerShadows";
import { configureWorldQuadMesh, createWorldQuadGeometry } from "@/lib/voxel/worldQuadGeometry";

type Vec2 = { x: number; y: number };
type Vec3 = Vec2 & { z: number };
type DepthMap = (u: number, v: number, depth: number) => number;
type ShadowSample = (map: DepthMap, size: Vec2, coord: Vec3, offset: Vec2, gradient: Vec2) => number;

function compile(material: THREE.Material, kind: "lambert" | "basic" | "depth" = "lambert") {
  const source = THREE.ShaderLib[kind];
  const shader = { ...source, uniforms: THREE.UniformsUtils.clone(source.uniforms) };
  material.onBeforeCompile(shader as Parameters<THREE.Material["onBeforeCompile"]>[0], {} as THREE.WebGLRenderer);
  return shader;
}

function shaderFunction<T>(source: string, name: string, parameters: string): T {
  const start = source.indexOf(`${name}(`);
  assert.ok(start >= 0, `${name} is present in the compiled shader`);
  const bodyStart = source.indexOf("{", start) + 1;
  const body = source.slice(bodyStart, source.indexOf("\n}", bodyStart))
    .replace(/\b(?:float|vec2|vec3)\s+(\w+)\s*=/g, "let $1 =");
  return runInNewContext(`(${parameters}) => { ${body} }`, {
    vec2: (x: number, y: number): Vec2 => ({ x, y }),
    vec3: (x: number, y: number, z: number): Vec3 => ({ x, y, z }),
    floor: Math.floor,
    clamp: THREE.MathUtils.clamp,
    dot: (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z,
    texture: (map: DepthMap, coord: Vec3) => map(coord.x, coord.y, coord.z),
  }) as T;
}

const material = new THREE.MeshLambertMaterial();
material.customProgramCacheKey = () => "existing-extension";
material.onBeforeCompile = function (shader) {
  assert.equal(this, material);
  shader.vertexShader += "\n// existing extension";
};
const version = material.version;
enableExplorerShadows(material);
assert.equal(material.version, version + 1);
assert.equal(material.customProgramCacheKey(), "existing-extension-explorer-shadow-plane-v1");
const shader = compile(material);
assert.match(shader.vertexShader, /existing extension/);
const native = THREE.ShaderChunk.shadowmap_pars_fragment;
const pcf = shader.fragmentShader.slice(
  shader.fragmentShader.indexOf("float getShadow( sampler2DShadow"),
  shader.fragmentShader.indexOf("#elif defined( SHADOWMAP_TYPE_VSM )"),
);
assert.equal([...pcf.matchAll(/sampleExplorerShadow\(/g)].length, 5);
assert.equal([...native.matchAll(/texture\( shadowMap, vec3\( shadowCoord.xy \+ vogelDiskSample/g)].length, 5);
assert.doesNotMatch(pcf, /texture\( shadowMap, vec3/);
assert.match(pcf, /shadowCoord.z \+= shadowBias;/);
assert.doesNotMatch(pcf, /dFd[xy]\(shadowCoord/, "close walls cannot infer slopes from quantized shadow coordinates");
assert.match(pcf, /explorerShadowGradient\(directionalShadowMatrix\[0\], inverseTransformDirection\(explorerViewNormal, viewMatrix\)\)/);
assert.match(pcf, /\) \* 0\.2;/);
assert.ok(shader.fragmentShader.includes(native.slice(native.indexOf("float getPointShadow("))), "point-shadow sampling is unchanged");

const gradientFor = shaderFunction<(matrix: number[][], normal: Vec3) => Vec2>(shader.fragmentShader, "explorerShadowGradient", "shadowMatrix, worldNormal");
const sample = shaderFunction<ShadowSample>(shader.fragmentShader, "sampleExplorerShadow", "shadowMap, shadowMapSize, shadowCoord, offset, depthGradient");
const columns = (matrix: THREE.Matrix4) => Array.from({ length: 4 }, (_, i) => matrix.elements.slice(i * 4, i * 4 + 4));
assert.deepEqual(gradientFor(columns(new THREE.Matrix4()), { x: 1, y: 0, z: 0 }), { x: 0, y: 0 }, "edge-on receivers avoid division by zero");

const mapSize = { x: 2048, y: 2048 };
const goldenAngle = Number(native.match(/const float goldenAngle = ([\d.]+);/)![1]);
function depthMap(depthAt: (u: number, v: number) => number): DepthMap {
  return (u, v, depth) => {
    const x = u * mapSize.x - 0.5, y = v * mapSize.y - 0.5;
    const left = Math.floor(x), bottom = Math.floor(y);
    let light = 0;
    for (let dx = 0; dx < 2; dx += 1) for (let dy = 0; dy < 2; dy += 1) {
      const sx = (THREE.MathUtils.clamp(left + dx, 0, mapSize.x - 1) + 0.5) / mapSize.x;
      const sy = (THREE.MathUtils.clamp(bottom + dy, 0, mapSize.y - 1) + 0.5) / mapSize.y;
      const storedDepth = Math.round(depthAt(sx, sy) * 0xffffff) / 0xffffff;
      if (depth <= storedDepth) light += (dx ? x - left : 1 - x + left) * (dy ? y - bottom : 1 - y + bottom);
    }
    return light;
  };
}

function filter(map: DepthMap, coord: Vec3, gradient: Vec2, phi: number, corrected: boolean): number {
  let light = 0;
  for (let index = 0; index < 5; index += 1) {
    const radius = Math.sqrt((index + 0.5) / 5) / mapSize.x;
    const theta = index * goldenAngle + phi;
    const offset = { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
    light += corrected ? sample(map, mapSize, coord, offset, gradient) : map(coord.x + offset.x, coord.y + offset.y, coord.z);
  }
  return light / 5;
}

const radius = Math.hypot(8192, 1459, 8192) / 2;
const sun = new THREE.DirectionalLight();
sun.position.copy(new THREE.Vector3(-0.46, 0.72, -0.52).normalize()).multiplyScalar(radius * 2.2);
Object.assign(sun.shadow.camera, { left: -radius * 1.1, right: radius * 1.1, top: radius * 1.1, bottom: -radius * 1.1, near: 0.1, far: radius * 4.2 });
sun.shadow.camera.updateProjectionMatrix();
sun.updateMatrixWorld();
sun.target.updateMatrixWorld();
sun.shadow.updateMatrices(sun);
const inverse = sun.shadow.matrix.clone().invert();
const uAxis = new THREE.Vector3().setFromMatrixColumn(inverse, 0);
const vAxis = new THREE.Vector3().setFromMatrixColumn(inverse, 1);
const depthAxis = new THREE.Vector3().setFromMatrixColumn(inverse, 2);
for (const normal of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1)]) {
  const expected = { x: -normal.dot(uAxis) / normal.dot(depthAxis), y: -normal.dot(vAxis) / normal.dot(depthAxis) };
  const actual = gradientFor(columns(sun.shadow.matrix), normal);
  assert.ok(Math.abs(actual.x - expected.x) < 1e-12);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-12);
  const floatMatrix = columns(sun.shadow.matrix).map((column) => column.map(Math.fround));
  const nearWall = gradientFor(floatMatrix, normal);
  assert.ok(Math.abs(nearWall.x - expected.x) < 1e-6 && Math.abs(nearWall.y - expected.y) < 1e-6, "analytical slopes retain float32 precision close to a wall");
}
let nativeMinimum = 1;
for (const normal of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1)]) {
  const depthPerBlock = 1 / normal.dot(depthAxis);
  const gradient = gradientFor(columns(sun.shadow.matrix), normal);
  const plane = (u: number, v: number) => 0.5 + gradient.x * (u - 0.5) + gradient.y * (v - 0.5);
  const ground = depthMap(plane);
  const blocker = depthMap((u, v) => plane(u, v) + 32 * depthPerBlock);
  for (let phase = 0; phase < 8; phase += 1) for (let x = 0; x < 16; x += 1) for (let y = 0; y < 16; y += 1) {
    const u = 0.5 + x / (16 * mapSize.x), v = 0.5 + y / (16 * mapSize.y);
    const coord = { x: u, y: v, z: plane(u, v) - 0.00015 + 1.025 * depthPerBlock };
    const phi = phase * Math.PI / 4;
    nativeMinimum = Math.min(nativeMinimum, filter(ground, coord, gradient, phi, false));
    assert.equal(filter(ground, coord, gradient, phi, true), 1, "flat ground and walls remain fully lit across texel phases");
    assert.equal(filter(blocker, coord, gradient, phi, true), 0, "elevated blockers still cast shadows");
  }
}
assert.ok(nativeMinimum < 0.65, "the installed PCF kernel reproduces the large-world self-shadow defect");

const flat = depthMap(() => 0.5);
for (const bias of [-0.00015, 0.00015]) {
  assert.equal(filter(flat, { x: 0.5, y: 0.5, z: 0.5 + bias }, { x: 0, y: 0 }, 0, true), bias < 0 ? 1 : 0, "the caller's bias is preserved");
}
assert.equal(filter(depthMap(() => 0.5 - 0.000001), { x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0 }, 0, true), 0, "sampling introduces no hidden bias that erases small blockers");
for (const u of [0, 1]) for (const v of [0, 1]) {
  const plane = (x: number, y: number) => 0.5 + 0.04 * x - 0.06 * y;
  assert.equal(filter(depthMap(plane), { x: u, y: v, z: plane(u, v) - 0.00015 }, { x: 0.04, y: -0.06 }, 0, true), 1, "map borders use clamped texel coordinates");
}
const edge = depthMap((u) => u < 0.5 ? 0.49 : 0.5);
const edgeLight = Array.from({ length: 17 }, (_, index) => filter(edge,
  { x: 0.5 + (index - 8) / (4 * mapSize.x), y: 0.5, z: 0.5 - 0.00015 }, { x: 0, y: 0 }, 0, true));
assert.equal(Math.min(...edgeLight), 0);
assert.equal(Math.max(...edgeLight), 1);
assert.ok(edgeLight.some((value) => value > 0 && value < 1), "the five-sample kernel retains soft blocker edges");

for (const water of [false, true]) {
  const texture = new THREE.Texture();
  const bounds = { box: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(2, 3, 4)), center: new THREE.Vector3(1, 1.5, 2), radius: 3 };
  const geometry = createWorldQuadGeometry(new Uint32Array([0, 2 | (3 << 10) | (4 << 20), 0, 1020]), bounds)!;
  const surface = new THREE.MeshLambertMaterial({ map: texture, transparent: water, opacity: 0.72, depthWrite: !water, side: THREE.DoubleSide, alphaTest: water ? 0 : 0.45 });
  const mesh = new THREE.Mesh(geometry, surface);
  configureWorldQuadMesh(mesh, [0, 0, 0], water);
  for (const [part, kind] of [[surface, "lambert"], [mesh.customDepthMaterial!, "depth"]] as const) {
    const before = compile(part, kind);
    const cacheKey = part.customProgramCacheKey();
    enableExplorerShadows(part);
    const after = compile(part, kind);
    assert.equal(after.vertexShader, before.vertexShader, "packed geometry decoding and normal offsets remain intact");
    assert.ok(part.customProgramCacheKey().startsWith(cacheKey));
    if (kind === "depth") assert.equal(after.fragmentShader, before.fragmentShader, "shadow casting retains the existing depth material");
    else {
      assert.match(after.fragmentShader, /sampleExplorerShadow\(/);
      assert.match(after.fragmentShader, /#include <alphatest_fragment>/);
      assert.equal(surface.transparent, water);
      assert.equal(surface.depthWrite, !water);
      assert.equal(surface.opacity, 0.72);
      assert.equal(surface.side, THREE.DoubleSide);
      assert.equal(surface.map, texture);
    }
  }
  geometry.dispose();
  surface.dispose();
  texture.dispose();
}
const unlit = new THREE.MeshBasicMaterial();
const unlitBefore = compile(unlit, "basic");
enableExplorerShadows(unlit);
assert.equal(compile(unlit, "basic").fragmentShader, unlitBefore.fragmentShader);
unlit.dispose();
material.dispose();
console.log("voxel explorer shadow checks passed");
