import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import { DIRS } from "../../../lib/voxel/ambientOcclusion";
import { WORLD_QUAD_COLORS } from "../../../lib/voxel/worldQuadData";
import { configureWorldQuadMesh, createWorldQuadGeometry } from "../../../lib/voxel/worldQuadGeometry";

const bounds = {
  box: new THREE.Box3(new THREE.Vector3(98, -2, -12), new THREE.Vector3(102, 2, -8)),
  center: new THREE.Vector3(100, 0, -10),
  radius: Math.sqrt(12),
};
const anchor = [17.5, 3.5, 29.5] as const;

function quad(face = 0, tint = 0, flip = 0): Uint32Array {
  return new Uint32Array([
    31 | (111 << 10) | (211 << 20),
    2 | (3 << 10) | (face << 20),
    56 | (728 << 16),
    tint | (0b11100100 << 2) | (flip << 10),
  ]);
}

function compile(material: THREE.Material, name: "lambert" | "basic" | "depth") {
  const source = THREE.ShaderLib[name];
  const shader = { ...source, uniforms: THREE.UniformsUtils.clone(source.uniforms) };
  material.onBeforeCompile(shader as Parameters<THREE.Material["onBeforeCompile"]>[0], {} as THREE.WebGLRenderer);
  return shader;
}

type DecodedQuad = { position: number[]; normal: number[]; uv: number[]; colorIndex: number };

function shaderDecoder(vertexShader: string) {
  const start = vertexShader.indexOf("uint worldQuadCorner");
  const end = vertexShader.indexOf("#include <uv_vertex>", start);
  assert.ok(start >= 0 && end > start);
  const scalarDecoder = vertexShader.slice(start, end)
    .replace(/\b(?:uint|int|float|vec2|vec3)\s+(\w+)\s*=/g, "let $1 =")
    .replace(/\b(\d+)u\b/g, "$1")
    .replace(/\b(?:uint|int|float)\(/g, "Number(")
    .replace(/>>/g, ">>>");
  return runInNewContext(`(position, worldQuad) => {
    ${scalarDecoder}
    return { position: worldQuadPosition, normal: worldQuadNormal, uv: worldQuadUv, colorIndex: worldQuadColorIndex };
  }`, {
    vec2: (x: number, y: number) => [x, y],
    vec3: (x: number, y: number, z: number) => [x, y, z],
  }) as (position: { x: number }, word: { x: number; y: number; z: number; w: number }) => DecodedQuad;
}

{
  assert.equal(createWorldQuadGeometry(null, bounds), null);
  assert.equal(createWorldQuadGeometry(new Uint32Array(), bounds), null);
  assert.throws(() => createWorldQuadGeometry(new Uint32Array(3), bounds), /four words/);
  const quads = new Uint32Array([...quad(), ...quad(5)]);
  const geometry = createWorldQuadGeometry(quads, bounds)!;
  const attribute = geometry.getAttribute("worldQuad") as THREE.InstancedBufferAttribute;
  assert.equal(geometry.isInstancedBufferGeometry, true);
  assert.equal(geometry.instanceCount, 2);
  assert.equal(attribute.isInstancedBufferAttribute, true);
  assert.equal(attribute.meshPerAttribute, 1);
  assert.equal(attribute.gpuType, THREE.IntType);
  assert.equal(attribute.normalized, false);
  assert.equal(attribute.array, quads);
  assert.equal(attribute.array.byteLength, geometry.instanceCount * 16);
  assert.equal(attribute.itemSize, 4);
  assert.equal(attribute.count, 2);
  assert.deepEqual(Array.from(geometry.index!.array), [0, 1, 2, 0, 2, 3]);
  for (const name of ["position", "normal", "uv", "color"]) assert.equal(geometry.getAttribute(name).count, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => geometry.getAttribute("position").getX(i)), [0, 1, 2, 3]);
  assert.ok(geometry.boundingBox!.equals(bounds.box));
  assert.ok(geometry.boundingSphere!.center.equals(bounds.center));
  assert.equal(geometry.boundingSphere!.radius, bounds.radius);
  assert.notEqual(geometry.boundingBox, bounds.box);
  assert.notEqual(geometry.boundingSphere!.center, bounds.center);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(100, 0, 0);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  assert.equal(frustum.intersectsObject(mesh), true, "batch bounds must remain visible when the base quad is outside the camera");
  geometry.dispose();
  mesh.material.dispose();
}

for (const water of [false, true]) {
  for (const kind of ["lambert", "basic"] as const) {
    const texture = new THREE.Texture();
    const material = kind === "lambert"
      ? new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.45, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ map: texture });
    const geometry = createWorldQuadGeometry(quad(), bounds)!;
    const mesh = new THREE.Mesh(geometry, material);
    configureWorldQuadMesh(mesh, anchor, water);
    assert.equal(material.vertexColors, true);
    assert.equal(material.allowOverride, false);
    assert.equal(mesh.frustumCulled, true);
    assert.ok(material.customProgramCacheKey().endsWith(water ? "water" : "atlas"));
    const depth = mesh.customDepthMaterial as THREE.MeshDepthMaterial;
    assert.ok(depth.isMeshDepthMaterial);
    assert.equal(depth.depthPacking, new THREE.MeshDepthMaterial().depthPacking);
    assert.equal(depth.map, texture);
    assert.equal(depth.alphaTest, material.alphaTest);
    assert.equal(depth.side, material.side);

    for (const [patchedMaterial, shaderKind] of [[material, kind], [depth, "depth"]] as const) {
      const shader = compile(patchedMaterial, shaderKind);
      assert.match(shader.vertexShader, /attribute uvec4 worldQuad/);
      assert.match(shader.vertexShader, /transformed = worldQuadPosition - worldQuadAnchor/);
      assert.match(shader.vertexShader, /objectNormal = worldQuadNormal/);
      assert.match(shader.vertexShader, /vMapUv = \(mapTransform \* vec3\(worldQuadUv, 1\.0\)\)\.xy/);
      assert.deepEqual((shader.uniforms.worldQuadAnchor.value as THREE.Vector3).toArray(), [...anchor]);
      assert.equal(shader.uniforms.worldQuadColors.value, WORLD_QUAD_COLORS);
      if (shaderKind !== "depth") assert.match(shader.vertexShader, /vColor\.rgb = worldQuadColors\[worldQuadColorIndex\]/);
      assert.match(shader.fragmentShader, /#include <alphatest_fragment>/);
      if (water) {
        assert.match(shader.fragmentShader, /#include <map_fragment>/);
        assert.doesNotMatch(shader.fragmentShader, /textureGrad/);
      } else {
        assert.match(shader.fragmentShader, /textureGrad\(map, worldQuadAtlasUv, dFdx\(vMapUv\) \* worldQuadTileSpan, dFdy\(vMapUv\) \* worldQuadTileSpan\)/);
        assert.match(shader.fragmentShader, /fract\(vMapUv\)/);
      }

      const decode = shaderDecoder(shader.vertexShader);
      for (let face = 0; face < DIRS.length; face += 1) {
        const direction = DIRS[face]!;
        const corners = direction.quad(0, 0, 0);
        const normal = [direction.nx, direction.ny, direction.nz];
        const normalAxis = normal.findIndex((component) => component !== 0);
        const uAxis = face < 2 ? (water ? 1 : 2) : 0;
        const vAxis = face < 2 ? (water ? 2 : 1) : face < 4 ? 1 : 2;
        for (let tint = 0; tint < 4; tint += 1) {
          for (let flip = 0; flip < 2; flip += 1) {
            const words = quad(face, tint, flip);
            for (let baseCorner = 0; baseCorner < 4; baseCorner += 1) {
              const corner = (baseCorner + flip) % 4;
              const decoded = decode({ x: baseCorner }, { x: words[0]!, y: words[1]!, z: words[2]!, w: words[3]! });
              const expectedPosition = [0, 0, 0];
              expectedPosition[normalAxis] = 31;
              expectedPosition[uAxis] = 111 + corners[corner]![uAxis]! * 2;
              expectedPosition[vAxis] = 211 + corners[corner]![vAxis]! * 3;
              const uvWidth = !water && face >= 4 ? 3 : 2;
              const uvHeight = !water && face >= 4 ? 2 : 3;
              const expectedUv = [corner >= 2 ? uvWidth : 0, corner === 1 || corner === 2 ? uvHeight : 0];
              assert.deepEqual(decoded.position, expectedPosition, `${shaderKind} water=${water} face=${face} corner=${corner}`);
              assert.deepEqual(decoded.normal, normal);
              assert.deepEqual(decoded.uv, expectedUv);
              assert.equal(decoded.colorIndex, tint * 4 + corner, "AO must follow the original corner after diagonal rotation");
            }
          }
        }
      }
    }
    let depthDisposals = 0;
    depth.addEventListener("dispose", () => { depthDisposals += 1; });
    geometry.dispose();
    geometry.dispose();
    assert.equal(depthDisposals, 1);
    material.dispose();
    texture.dispose();
  }
}

{
  const geometry = createWorldQuadGeometry(quad(), bounds)!;
  const material = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const override = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
  let beforeRenderCalls = 0;
  material.onBeforeRender = () => { beforeRenderCalls += 1; };
  configureWorldQuadMesh(mesh, anchor, true);
  const render = () => material.onBeforeRender({} as THREE.WebGLRenderer, scene, camera, geometry, mesh, {} as THREE.Group);
  scene.overrideMaterial = override;
  render();
  render();
  assert.equal(material.colorWrite, false);
  assert.equal(material.depthWrite, true);
  scene.overrideMaterial = null;
  render();
  assert.equal(material.colorWrite, true);
  assert.equal(material.depthWrite, false);
  material.colorWrite = false;
  material.depthWrite = true;
  scene.overrideMaterial = override;
  render();
  scene.overrideMaterial = null;
  render();
  assert.equal(material.colorWrite, false, "normal-pass state changes must survive the next override");
  assert.equal(material.depthWrite, true);
  assert.equal(beforeRenderCalls, 5);
  geometry.dispose();
  material.dispose();
  override.dispose();
}

console.log("world-quad-geometry tests passed");
