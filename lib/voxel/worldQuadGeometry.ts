import * as THREE from "three";
import { ATLAS } from "@/lib/blocks/atlas";
import type { VoxelGroup } from "@/lib/voxel/mesh";
import { WORLD_QUAD_COLORS } from "@/lib/voxel/worldQuadData";

const QUADS_PER_INSTANCE = 64;
const QUAD_TEXTURE_WIDTH = 2048;
export const WORLD_QUAD_TEXTURE_CAPACITY = QUAD_TEXTURE_WIDTH ** 2;

export function createWorldQuadGeometry(
  quads: Uint32Array | null,
  bounds: VoxelGroup["bounds"],
): THREE.InstancedBufferGeometry | null {
  if (!quads?.length) return null;
  if (quads.length % 4 !== 0) throw new Error("World quad data must contain four words per face");
  const count = quads.length / 4;
  if (count > WORLD_QUAD_TEXTURE_CAPACITY) throw new Error("World quad page exceeds texture capacity");
  const width = Math.min(QUAD_TEXTURE_WIDTH, Math.ceil(count / QUADS_PER_INSTANCE) * QUADS_PER_INSTANCE);
  const height = Math.ceil(count / width);
  const data = new Uint32Array(width * height * 4);
  data.set(quads);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
  texture.internalFormat = "RGBA32UI";
  texture.needsUpdate = true;
  const vertices = QUADS_PER_INSTANCE * 4;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Uint8BufferAttribute(Uint8Array.from({ length: vertices }, (_, i) => i), 1));
  geometry.setAttribute("normal", new THREE.Int8BufferAttribute(Int8Array.from({ length: vertices * 3 }, (_, i) => i % 3 === 1 ? 1 : 0), 3));
  geometry.setAttribute("uv", new THREE.Uint8BufferAttribute(Uint8Array.from({ length: vertices * 2 }, (_, i) => [0, 0, 0, 1, 1, 1, 1, 0][i % 8]!), 2));
  geometry.setAttribute("color", new THREE.Uint8BufferAttribute(new Uint8Array(vertices * 3).fill(255), 3, true));
  geometry.setIndex(Array.from({ length: QUADS_PER_INSTANCE * 6 }, (_, i) => Math.floor(i / 6) * 4 + [0, 1, 2, 0, 2, 3][i % 6]!));
  geometry.instanceCount = Math.ceil(count / QUADS_PER_INSTANCE);
  geometry.userData.worldQuadTexture = texture;
  geometry.userData.worldQuadCount = count;
  const disposeTexture = () => {
    texture.dispose();
    geometry.removeEventListener("dispose", disposeTexture);
  };
  geometry.addEventListener("dispose", disposeTexture);
  geometry.boundingBox = bounds.box.clone();
  geometry.boundingSphere = new THREE.Sphere(bounds.center.clone(), bounds.radius);
  return geometry;
}

function quadDecoder(water: boolean): string {
  return `
uint worldQuadCorner = (uint(position.x) + ((worldQuad.w >> 10u) & 1u)) & 3u;
uint worldQuadFace = (worldQuad.y >> 20u) & 7u;
float worldQuadPlane = float(worldQuad.x & 1023u);
float worldQuadU = float((worldQuad.x >> 10u) & 1023u);
float worldQuadV = float((worldQuad.x >> 20u) & 1023u);
float worldQuadWidth = float(worldQuad.y & 1023u);
float worldQuadHeight = float((worldQuad.y >> 10u) & 1023u);
float worldQuadS = worldQuadCorner >= 2u ? 1.0 : 0.0;
float worldQuadT = worldQuadCorner == 1u || worldQuadCorner == 2u ? 1.0 : 0.0;
float worldQuadX = 0.0;
float worldQuadY = 0.0;
float worldQuadZ = 0.0;
if (worldQuadFace < 2u) {
  worldQuadX = worldQuadPlane;
  worldQuadY = ${water ? "worldQuadU + worldQuadT * worldQuadWidth" : "worldQuadV + worldQuadT * worldQuadHeight"};
  worldQuadZ = ${water ? "worldQuadV + (worldQuadFace == 0u ? worldQuadS : 1.0 - worldQuadS) * worldQuadHeight" : "worldQuadU + (worldQuadFace == 0u ? worldQuadS : 1.0 - worldQuadS) * worldQuadWidth"};
} else if (worldQuadFace < 4u) {
  worldQuadX = worldQuadU + (worldQuadFace == 2u ? worldQuadS : 1.0 - worldQuadS) * worldQuadWidth;
  worldQuadY = worldQuadV + worldQuadT * worldQuadHeight;
  worldQuadZ = worldQuadPlane;
} else {
  worldQuadX = worldQuadU + worldQuadT * worldQuadWidth;
  worldQuadY = worldQuadPlane;
  worldQuadZ = worldQuadV + (worldQuadFace == 4u ? 1.0 - worldQuadS : worldQuadS) * worldQuadHeight;
}
vec3 worldQuadPosition = vec3(worldQuadX, worldQuadY, worldQuadZ);
vec3 worldQuadNormal = worldQuadFace < 2u
  ? vec3(worldQuadFace == 0u ? 1.0 : -1.0, 0.0, 0.0)
  : worldQuadFace < 4u ? vec3(0.0, 0.0, worldQuadFace == 2u ? -1.0 : 1.0)
  : vec3(0.0, worldQuadFace == 4u ? 1.0 : -1.0, 0.0);
vec2 worldQuadUv = ${water ? "worldQuadFace >= 2u && worldQuadFace < 4u" : "worldQuadFace < 4u"} ? vec2(worldQuadS * worldQuadWidth, worldQuadT * worldQuadHeight) : vec2(worldQuadS * worldQuadHeight, worldQuadT * worldQuadWidth);
int worldQuadColorIndex = int((worldQuad.w & 3u) * 4u + ((worldQuad.w >> (2u + worldQuadCorner * 2u)) & 3u));
`;
}

function surfaceMapFragment(): string {
  return `
vec2 worldSurfaceDx = dFdx(vMapUv) * worldQuadAtlasTexel * ${ATLAS.tileSize.toFixed(1)};
vec2 worldSurfaceDy = dFdy(vMapUv) * worldQuadAtlasTexel * ${ATLAS.tileSize.toFixed(1)};
uvec2 worldSurfaceSize = uvec2(vWorldSurfaceQuad.y & 1023u, (vWorldSurfaceQuad.y >> 10u) & 1023u);
uvec2 worldSurfaceCell = uvec2(clamp(floor(vWorldSurfaceUv), vec2(0.0), vec2(worldSurfaceSize) - 1.0));
uint worldSurfaceHeaderOffset = vWorldSurfaceQuad.z + worldSurfaceCell.y;
uint worldSurfaceHeader = texelFetch(worldSurfaceData, ivec2(worldSurfaceHeaderOffset % 2048u, worldSurfaceHeaderOffset / 2048u), 0).r;
uint worldSurfaceBit = 1u << worldSurfaceCell.x;
if ((worldSurfaceHeader & worldSurfaceBit) == 0u) discard;
uint worldSurfaceRank = worldSurfaceHeader & (worldSurfaceBit - 1u);
worldSurfaceRank -= (worldSurfaceRank >> 1u) & 0x5555u;
worldSurfaceRank = (worldSurfaceRank & 0x3333u) + ((worldSurfaceRank >> 2u) & 0x3333u);
worldSurfaceRank = (worldSurfaceRank + (worldSurfaceRank >> 4u)) & 0x0f0fu;
worldSurfaceRank = (worldSurfaceRank + (worldSurfaceRank >> 8u)) & 31u;
uint worldSurfaceOffset = vWorldSurfaceQuad.z + worldSurfaceSize.y + (worldSurfaceHeader >> 16u) + worldSurfaceRank;
uint worldSurfaceWord = texelFetch(worldSurfaceData, ivec2(worldSurfaceOffset % 2048u, worldSurfaceOffset / 2048u), 0).r;
vec2 worldSurfaceAtlas = vec2(worldSurfaceWord & 1023u, (worldSurfaceWord >> 10u) & 1023u) * worldQuadAtlasTexel;
vec2 worldSurfaceSt = fract(vMapUv);
diffuseColor *= textureGrad(map, worldSurfaceAtlas + worldSurfaceSt * worldQuadAtlasTexel * ${ATLAS.tileSize.toFixed(1)}, worldSurfaceDx, worldSurfaceDy);
uint worldSurfaceFlags = (worldSurfaceWord >> 20u) & 2047u;
int worldSurfaceTint = int(worldSurfaceFlags & 3u) * 4;
vec3 worldSurfaceC0 = worldQuadColors[worldSurfaceTint + int((worldSurfaceFlags >> 2u) & 3u)];
vec3 worldSurfaceC1 = worldQuadColors[worldSurfaceTint + int((worldSurfaceFlags >> 4u) & 3u)];
vec3 worldSurfaceC2 = worldQuadColors[worldSurfaceTint + int((worldSurfaceFlags >> 6u) & 3u)];
vec3 worldSurfaceC3 = worldQuadColors[worldSurfaceTint + int((worldSurfaceFlags >> 8u) & 3u)];
float worldSurfaceS = worldSurfaceSt.x;
float worldSurfaceT = worldSurfaceSt.y;
vec3 worldSurfaceColor;
if ((worldSurfaceFlags & 1024u) == 0u) {
  worldSurfaceColor = worldSurfaceS <= worldSurfaceT
    ? worldSurfaceC0 * (1.0 - worldSurfaceT) + worldSurfaceC1 * (worldSurfaceT - worldSurfaceS) + worldSurfaceC2 * worldSurfaceS
    : worldSurfaceC0 * (1.0 - worldSurfaceS) + worldSurfaceC2 * worldSurfaceT + worldSurfaceC3 * (worldSurfaceS - worldSurfaceT);
} else {
  worldSurfaceColor = worldSurfaceS + worldSurfaceT <= 1.0
    ? worldSurfaceC0 * (1.0 - worldSurfaceS - worldSurfaceT) + worldSurfaceC1 * worldSurfaceT + worldSurfaceC3 * worldSurfaceS
    : worldSurfaceC1 * (1.0 - worldSurfaceS) + worldSurfaceC2 * (worldSurfaceS + worldSurfaceT - 1.0) + worldSurfaceC3 * (1.0 - worldSurfaceT);
}
diffuseColor.rgb *= worldSurfaceColor;
`;
}

function patchQuadMaterial(material: THREE.Material, anchor: readonly [number, number, number], water: boolean, data: THREE.DataTexture, surface?: THREE.DataTexture, ranges?: Int32Array | null): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.worldQuadAnchor = { value: new THREE.Vector3().fromArray(anchor) };
    shader.uniforms.worldQuadColors = { value: WORLD_QUAD_COLORS };
    shader.uniforms.worldQuadAtlasTexel = { value: new THREE.Vector2(1 / ATLAS.atlasWidth, 1 / ATLAS.atlasHeight) };
    shader.uniforms.worldQuadData = { value: data };
    shader.uniforms.worldQuadDataWidth = { value: data.image.width };
    if (surface) shader.uniforms.worldSurfaceData = { value: surface };
    if (ranges) shader.uniforms.worldQuadRanges = { value: ranges };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
uniform highp usampler2D worldQuadData;
uniform int worldQuadDataWidth;
${ranges ? "uniform ivec2 worldQuadRanges[6];" : ""}
uniform vec3 worldQuadAnchor;
uniform vec3 worldQuadColors[16];
uniform vec2 worldQuadAtlasTexel;
flat varying vec2 vWorldQuadAtlasOrigin;
${surface ? "flat varying uvec4 vWorldSurfaceQuad;\nvarying vec2 vWorldSurfaceUv;" : ""}`)
      .replace("#include <uv_vertex>", `uint worldQuadIndex = uint(gl_InstanceID) * ${QUADS_PER_INSTANCE}u + (uint(position.x) >> 2u);
${ranges ? `bool worldQuadDrawn = worldQuadIndex < uint(worldQuadRanges[5].y);
for (int range = 0; range < 6; range++) {
  if (worldQuadIndex < uint(worldQuadRanges[range].y)) {
    worldQuadIndex += uint(worldQuadRanges[range].x);
    break;
  }
}` : ""}
uvec4 worldQuad = ${ranges ? "worldQuadDrawn ? " : ""}texelFetch(worldQuadData, ivec2(worldQuadIndex % uint(worldQuadDataWidth), worldQuadIndex / uint(worldQuadDataWidth)), 0)${ranges ? " : uvec4(0u)" : ""};
${quadDecoder(water)}
#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = (mapTransform * vec3(worldQuadUv, 1.0)).xy;
#endif
vWorldQuadAtlasOrigin = vec2(worldQuad.z & 65535u, worldQuad.z >> 16u) * worldQuadAtlasTexel;
${surface ? `vWorldSurfaceQuad = worldQuad;
vWorldSurfaceUv = worldQuadFace < 4u
  ? vec2((worldQuadFace == 0u || worldQuadFace == 2u ? worldQuadS : 1.0 - worldQuadS) * worldQuadWidth, worldQuadT * worldQuadHeight)
  : vec2(worldQuadT * worldQuadWidth, (worldQuadFace == 4u ? 1.0 - worldQuadS : worldQuadS) * worldQuadHeight);` : ""}`)
      .replace("#include <color_vertex>", `#include <color_vertex>
#if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
  vColor.rgb = worldQuadColors[worldQuadColorIndex];
#endif`)
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = worldQuadNormal;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
transformed = worldQuadPosition - worldQuadAnchor;
#ifdef USE_ALPHAHASH
  vPosition = transformed;
#endif`);
    if (!water) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
uniform vec2 worldQuadAtlasTexel;
flat varying vec2 vWorldQuadAtlasOrigin;
${surface ? "uniform highp usampler2D worldSurfaceData;\nuniform vec3 worldQuadColors[16];\nflat varying uvec4 vWorldSurfaceQuad;\nvarying vec2 vWorldSurfaceUv;" : ""}`)
        .replace("#include <map_fragment>", surface ? surfaceMapFragment() : `#ifdef USE_MAP
  vec2 worldQuadTileSpan = worldQuadAtlasTexel * ${ATLAS.tileSize.toFixed(1)};
  vec2 worldQuadAtlasUv = vWorldQuadAtlasOrigin + fract(vMapUv) * worldQuadTileSpan;
  vec4 sampledDiffuseColor = textureGrad(map, worldQuadAtlasUv, dFdx(vMapUv) * worldQuadTileSpan, dFdy(vMapUv) * worldQuadTileSpan);
  diffuseColor *= sampledDiffuseColor;
#endif`);
    }
  };
  material.customProgramCacheKey = () => `voxel-world-quad-batch-${water ? "water" : "atlas"}${surface ? "-surface" : ""}${ranges ? "-ranges" : ""}`;
  material.needsUpdate = true;
}

// sorted surface planes let one draw skip faces pointing away from the camera
function configureSurfaceCulling(mesh: THREE.Mesh, anchor: readonly [number, number, number], data: THREE.DataTexture): Int32Array | null {
  const geometry = mesh.geometry as THREE.InstancedBufferGeometry;
  const count = geometry.userData.worldQuadCount as number;
  const words = data.image.data as Uint32Array;
  const faces: { face: number; start: number; count: number; plane: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const face = (words[index * 4 + 1]! >>> 20) & 7;
    const plane = words[index * 4]! & 1023;
    let group = faces.at(-1);
    if (group?.face !== face) {
      if (faces.some((entry) => entry.face === face) || faces.length === 6) return null;
      group = { face, start: index, count: 0, plane };
      faces.push(group);
    }
    if (plane < group.plane) return null;
    group.count += 1;
    group.plane = plane;
  }
  const ranges = new Int32Array(12);
  const cameraPosition = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const reset = () => {
    for (let i = 0; i < 6; i += 1) {
      ranges[i * 2] = 0;
      ranges[i * 2 + 1] = count;
    }
    geometry.instanceCount = Math.ceil(count / QUADS_PER_INSTANCE);
  };
  reset();
  const beforeRender = mesh.onBeforeRender;
  mesh.onBeforeRender = (...args) => {
    const camera = args[2];
    if (!(camera instanceof THREE.PerspectiveCamera) || args[4].side !== THREE.FrontSide) reset();
    else {
      cameraPosition.setFromMatrixPosition(camera.matrixWorld)
        .applyMatrix4(inverse.copy(mesh.matrixWorld).invert());
      let visible = 0;
      for (let i = 0; i < 6; i += 1) {
        const group = faces[i];
        ranges[i * 2] = 0;
        if (group) {
          const axis = group.face < 2 ? 0 : group.face < 4 ? 2 : 1;
          const position = cameraPosition.getComponent(axis) + anchor[axis];
          const positive = group.face === 0 || group.face === 3 || group.face === 4;
          let low = group.start, high = low + group.count;
          if (position < (words[low * 4]! & 1023)) high = low;
          else if (position > group.plane) low = high;
          while (low < high) {
            const mid = (low + high) >>> 1;
            const plane = words[mid * 4]! & 1023;
            if (positive ? plane <= position : plane < position) low = mid + 1;
            else high = mid;
          }
          const start = positive ? group.start : low;
          const end = positive ? low : group.start + group.count;
          ranges[i * 2] = start - visible;
          visible += end - start;
        }
        ranges[i * 2 + 1] = visible;
      }
      geometry.instanceCount = Math.ceil(visible / QUADS_PER_INSTANCE);
    }
    beforeRender.apply(mesh, args);
  };
  const beforeShadow = mesh.onBeforeShadow;
  mesh.onBeforeShadow = (...args) => {
    // shadow cameras need the complete caster
    reset();
    beforeShadow.apply(mesh, args);
  };
  return ranges;
}

export function configureWorldQuadMesh(
  mesh: THREE.Mesh,
  anchor: readonly [number, number, number],
  water: boolean,
  surface?: THREE.DataTexture,
): void {
  const data = mesh.geometry.userData.worldQuadTexture as THREE.DataTexture;
  if (!(data instanceof THREE.DataTexture)) throw new Error("World quad geometry data is missing");
  const ranges = surface ? configureSurfaceCulling(mesh, anchor, data) : null;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    patchQuadMaterial(material, anchor, water, data, surface, ranges);
    material.vertexColors = !surface;
    material.allowOverride = false;
  }
  const source = materials[0] as THREE.MeshLambertMaterial;
  const depth = new THREE.MeshDepthMaterial({ map: source.map, alphaMap: source.alphaMap, alphaTest: source.alphaTest, side: source.side });
  patchQuadMaterial(depth, anchor, water, data, surface, ranges);
  mesh.customDepthMaterial = depth;
  const geometry = mesh.geometry;
  const disposeDepth = () => {
    depth.dispose();
    surface?.dispose();
    geometry.removeEventListener("dispose", disposeDepth);
  };
  geometry.addEventListener("dispose", disposeDepth);
}

export function renderWorldQuadDepth(meshes: readonly THREE.Mesh[], render: () => void): void {
  const states = meshes.flatMap((mesh) => {
    const depth = mesh.customDepthMaterial;
    return depth ? [{ mesh, depth, material: mesh.material, colorWrite: depth.colorWrite,
      depthWrite: depth.depthWrite, allowOverride: depth.allowOverride, side: depth.side, visible: mesh.visible }] : [];
  });
  try {
    for (const { mesh, depth, material } of states) {
      if (mesh.userData.worldDepthRole) mesh.visible = mesh.userData.worldDepthRole === "replacement";
      const source = Array.isArray(material) ? material[0] : material;
      depth.colorWrite = false;
      depth.depthWrite = true;
      depth.allowOverride = false;
      // shadow rendering can leave the custom depth material facing backwards
      depth.side = source?.side ?? THREE.FrontSide;
      mesh.material = depth;
    }
    render();
  } finally {
    for (const { mesh, depth, material, colorWrite, depthWrite, allowOverride, side, visible } of states) {
      mesh.material = material;
      mesh.visible = visible;
      Object.assign(depth, { colorWrite, depthWrite, allowOverride, side });
    }
  }
}
