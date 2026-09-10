import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import { DIRS } from "../../../lib/voxel/ambientOcclusion";
import { WORLD_QUAD_COLORS } from "../../../lib/voxel/worldQuadData";
import { configureWorldQuadMesh, createWorldQuadGeometry, renderWorldQuadDepth } from "../../../lib/voxel/worldQuadGeometry";
import { createVoxelGroupFromMeshPayload } from "../../../lib/voxel/mesh";
import { packWorldSurfaceTiles } from "../../../lib/voxel/worldSurfaceTiles";

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
  const texture = geometry.userData.worldQuadTexture as THREE.DataTexture;
  const data = texture.image.data as Uint32Array;
  assert.equal(geometry.isInstancedBufferGeometry, true);
  assert.equal(geometry.instanceCount, 1);
  assert.equal(geometry.userData.worldQuadCount, 2);
  assert.equal(texture.format, THREE.RGBAIntegerFormat);
  assert.equal(texture.type, THREE.UnsignedIntType);
  assert.deepEqual(data.subarray(0, quads.length), quads);
  assert.ok(data.subarray(quads.length).every((word) => word === 0), "padding creates only degenerate faces");
  assert.deepEqual(Array.from(geometry.index!.array).slice(0, 12), [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  for (const name of ["position", "normal", "uv", "color"]) assert.equal(geometry.getAttribute(name).count, 256);
  assert.deepEqual([0, 1, 2, 3].map((i) => geometry.getAttribute("position").getX(i)), [0, 1, 2, 3]);
  assert.equal(geometry.getAttribute("position").getX(255), 255, "the final corner must fit the vertex index attribute");
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

{
  const quads = new Uint32Array(65 * 4);
  for (let index = 0; index < 65; index += 1) quads.set(quad(index % 6), index * 4);
  const geometry = createWorldQuadGeometry(quads, bounds)!;
  const texture = geometry.userData.worldQuadTexture as THREE.DataTexture;
  const data = texture.image.data as Uint32Array;
  assert.equal(geometry.instanceCount, 2);
  assert.deepEqual(data.subarray(0, quads.length), quads);
  assert.ok(data.subarray(quads.length).every((word) => word === 0));
  geometry.dispose();
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
      assert.ok(shader.vertexShader.includes("uniform highp usampler2D worldQuadData"));
      assert.equal(shader.uniforms.worldQuadData.value, geometry.userData.worldQuadTexture);
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
              const uvWidth = face >= 4 || (water && face < 2) ? 3 : 2;
              const uvHeight = face >= 4 || (water && face < 2) ? 2 : 3;
              const expectedUv = [corner >= 2 ? uvWidth : 0, corner === 1 || corner === 2 ? uvHeight : 0];
              assert.deepEqual(decoded.position, expectedPosition, `${shaderKind} water=${water} face=${face} corner=${corner}`);
              assert.deepEqual(decoded.normal, normal);
              assert.deepEqual(decoded.uv, expectedUv);
              assert.equal(decoded.colorIndex, tint * 4 + corner, "AO must follow the original corner after diagonal rotation");
              const next = decode({ x: (baseCorner + 1) % 4 }, { x: words[0]!, y: words[1]!, z: words[2]!, w: words[3]! });
              assert.equal(
                Math.hypot(...decoded.uv.map((value, axis) => value - next.uv[axis]!)),
                Math.hypot(...decoded.position.map((value, axis) => value - next.position[axis]!)),
                `${shaderKind} water=${water} face=${face} edges repeat the texture once per block`,
              );
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
  const material = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  configureWorldQuadMesh(mesh, anchor, true);
  const depth = mesh.customDepthMaterial!;
  depth.side = THREE.BackSide;
  const checkDepth = () => {
    assert.equal(mesh.material, depth, "the occlusion pass must run the quad depth shader");
    assert.equal(depth.allowOverride, false);
    assert.equal(depth.colorWrite, false);
    assert.equal(depth.depthWrite, true);
    assert.equal(depth.transparent, false, "double-sided water needs one depth draw");
    assert.equal(depth.side, THREE.DoubleSide);
    assert.ok(compile(depth, "depth").vertexShader.includes("transformed = worldQuadPosition - worldQuadAnchor"));
  };
  renderWorldQuadDepth([mesh], checkDepth);
  assert.throws(() => renderWorldQuadDepth([mesh], () => { checkDepth(); throw new Error("draw failed"); }), /draw failed/);
  assert.equal(mesh.material, material);
  assert.equal(material.colorWrite, true);
  assert.equal(material.depthWrite, false);
  assert.equal(depth.colorWrite, true);
  assert.equal(depth.allowOverride, true);
  assert.equal(depth.side, THREE.BackSide, "later shadow draws retain their original state");
  geometry.dispose();
  material.dispose();
}

{
  const transparent = new Uint32Array([
    31 | (112 << 10) | (211 << 20), 1 | (1 << 10), 56 | (728 << 16), 0xff << 2,
    31 | (113 << 10) | (211 << 20), 1 | (1 << 10), 56 | (728 << 16), 0xff << 2,
  ]);
  const packed = packWorldSurfaceTiles(transparent);
  const page = packed.surfaces[0]!;
  const shared = new Uint32Array(page.texels.length + 4);
  shared.set(page.texels, 4);
  page.texels = shared.subarray(4);
  const texture = new THREE.Texture();
  const rendered = createVoxelGroupFromMeshPayload({
    opaque: null, cutout: null, transparent: null, water: null, emissive: null,
    filteredBlockCount: 2,
    bounds: { min: bounds.box.min.toArray(), max: bounds.box.max.toArray(), center: bounds.center.toArray(), radius: bounds.radius },
    worldQuads: { anchor: [...anchor], opaque: null, cutout: null, transparent, water: null, emissive: null,
      transparentDepth: { quads: packed.opaque, surfaces: packed.surfaces } },
  }, texture);
  const meshes = rendered.group.children as THREE.Mesh[];
  const source = meshes.find((mesh) => mesh.userData.worldDepthRole === "source")!;
  const replacement = meshes.find((mesh) => mesh.userData.worldDepthRole === "replacement")!;
  assert.ok(source && replacement);
  assert.equal(source.visible, true);
  assert.equal(replacement.visible, false);
  assert.equal((source.material as THREE.Material).transparent, true);
  const data = source.geometry.userData.worldQuadTexture.image.data as Uint32Array;
  assert.deepEqual(data.subarray(0, transparent.length), transparent, "main alpha drawing retains its original face order");
  assert.equal(replacement.geometry.userData.worldQuadCount, 1);
  const depthTexture = compile(replacement.customDepthMaterial!, "depth").uniforms.worldSurfaceData.value as THREE.DataTexture;
  assert.deepEqual(depthTexture.image.data, page.texels);
  assert.notEqual(depthTexture.image.data.buffer, shared.buffer, "a surface texture must not retain other decoded buckets");
  const check = () => {
    assert.equal(source.visible, false);
    assert.equal(replacement.visible, true);
    assert.equal(replacement.material, replacement.customDepthMaterial);
  };
  renderWorldQuadDepth(meshes, check);
  assert.throws(() => renderWorldQuadDepth(meshes, () => { check(); throw new Error("depth failed"); }), /depth failed/);
  assert.equal(source.visible, true);
  assert.equal(replacement.visible, false);
  assert.equal((source.material as THREE.Material).transparent, true);
  rendered.dispose();
  texture.dispose();
}

console.log("world-quad-geometry tests passed");
