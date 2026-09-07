import * as THREE from "three";
import { ATLAS } from "@/lib/blocks/atlas";
import type { VoxelGroup } from "@/lib/voxel/mesh";
import { WORLD_QUAD_COLORS } from "@/lib/voxel/worldQuadData";

export function createWorldQuadGeometry(
  quads: Uint32Array | null,
  bounds: VoxelGroup["bounds"],
): THREE.InstancedBufferGeometry | null {
  if (!quads?.length) return null;
  if (quads.length % 4 !== 0) throw new Error("World quad data must contain four words per face");
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], 3));
  geometry.setAttribute("normal", new THREE.Int8BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute("uv", new THREE.Uint8BufferAttribute([0, 0, 0, 1, 1, 1, 1, 0], 2));
  geometry.setAttribute("color", new THREE.Uint8BufferAttribute(new Uint8Array(12).fill(255), 3, true));
  const attribute = new THREE.InstancedBufferAttribute(quads, 4);
  attribute.gpuType = THREE.IntType;
  geometry.setAttribute("worldQuad", attribute);
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = quads.length / 4;
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
vec2 worldQuadUv = ${water ? "vec2(worldQuadS * worldQuadWidth, worldQuadT * worldQuadHeight)" : "worldQuadFace < 4u ? vec2(worldQuadS * worldQuadWidth, worldQuadT * worldQuadHeight) : vec2(worldQuadS * worldQuadHeight, worldQuadT * worldQuadWidth)"};
int worldQuadColorIndex = int((worldQuad.w & 3u) * 4u + ((worldQuad.w >> (2u + worldQuadCorner * 2u)) & 3u));
`;
}

function patchQuadMaterial(material: THREE.Material, anchor: readonly [number, number, number], water: boolean): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.worldQuadAnchor = { value: new THREE.Vector3().fromArray(anchor) };
    shader.uniforms.worldQuadColors = { value: WORLD_QUAD_COLORS };
    shader.uniforms.worldQuadAtlasTexel = { value: new THREE.Vector2(1 / ATLAS.atlasWidth, 1 / ATLAS.atlasHeight) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute uvec4 worldQuad;
uniform vec3 worldQuadAnchor;
uniform vec3 worldQuadColors[16];
uniform vec2 worldQuadAtlasTexel;
flat varying vec2 vWorldQuadAtlasOrigin;`)
      .replace("#include <uv_vertex>", `${quadDecoder(water)}
#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = (mapTransform * vec3(worldQuadUv, 1.0)).xy;
#endif
vWorldQuadAtlasOrigin = vec2(worldQuad.z & 65535u, worldQuad.z >> 16u) * worldQuadAtlasTexel;`)
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
flat varying vec2 vWorldQuadAtlasOrigin;`)
        .replace("#include <map_fragment>", `#ifdef USE_MAP
  vec2 worldQuadTileSpan = worldQuadAtlasTexel * ${ATLAS.tileSize.toFixed(1)};
  vec2 worldQuadAtlasUv = vWorldQuadAtlasOrigin + fract(vMapUv) * worldQuadTileSpan;
  vec4 sampledDiffuseColor = textureGrad(map, worldQuadAtlasUv, dFdx(vMapUv) * worldQuadTileSpan, dFdy(vMapUv) * worldQuadTileSpan);
  diffuseColor *= sampledDiffuseColor;
#endif`);
    }
  };
  material.customProgramCacheKey = () => `voxel-world-quad-v1-${water ? "water" : "atlas"}`;
  material.needsUpdate = true;
}

export function configureWorldQuadMesh(
  mesh: THREE.Mesh,
  anchor: readonly [number, number, number],
  water: boolean,
): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    patchQuadMaterial(material, anchor, water);
    material.vertexColors = true;
    material.allowOverride = false;
    const beforeRender = material.onBeforeRender;
    let overriding = false;
    let colorWrite = material.colorWrite;
    let depthWrite = material.depthWrite;
    material.onBeforeRender = (...args) => {
      beforeRender.apply(material, args);
      const override = args[1].overrideMaterial;
      if (override) {
        if (!overriding) {
          colorWrite = material.colorWrite;
          depthWrite = material.depthWrite;
          overriding = true;
        }
        material.colorWrite = override.colorWrite;
        material.depthWrite = override.depthWrite;
      } else if (overriding) {
        material.colorWrite = colorWrite;
        material.depthWrite = depthWrite;
        overriding = false;
      }
    };
  }
  const source = materials[0] as THREE.MeshLambertMaterial;
  const depth = new THREE.MeshDepthMaterial({ map: source.map, alphaMap: source.alphaMap, alphaTest: source.alphaTest, side: source.side });
  patchQuadMaterial(depth, anchor, water);
  mesh.customDepthMaterial = depth;
  const geometry = mesh.geometry;
  const disposeDepth = () => {
    depth.dispose();
    geometry.removeEventListener("dispose", disposeDepth);
  };
  geometry.addEventListener("dispose", disposeDepth);
}
