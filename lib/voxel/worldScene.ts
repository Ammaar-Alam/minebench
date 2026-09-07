import * as THREE from "three";
import { getAtlasUv, hasAtlasKey } from "@/lib/blocks/atlas";
import type { BlockDefinition, RenderKind } from "@/lib/blocks/palettes";
import { getRenderKind } from "@/lib/blocks/registry";
import { getTextureKey, type Face } from "@/lib/blocks/textures";
import { decodeBinaryVoxelBuild, readBinaryVoxelBuildHeader } from "@/lib/voxel/binaryBuild";
import {
  configureAtlasTexture,
  createVoxelGroupAsync,
  type VoxelGroup,
} from "@/lib/voxel/mesh";
import {
  type PackedVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type { VoxelPoint } from "@/lib/voxel/types";
import { createWorldLodPackedBlocks } from "@/lib/voxel/worldLod";
import {
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  voxelWorldPartUrl,
  type VoxelWorldBounds,
  type VoxelWorldDelivery,
  type VoxelWorldManifest,
  type VoxelWorldMixedRegion,
  type VoxelWorldPartRef,
  type VoxelWorldRegion,
  type VoxelWorldRegionPage,
  type VoxelWorldRegionPageRef,
  type VoxelWorldUniformRegion,
} from "@/lib/voxel/world";

export type VoxelWorldSceneStats = {
  residentRegions: number;
  uniformRegions: number;
  mixedDetailRegions: number;
  mixedProxyRegions: number;
  residentRegionPages: number;
  loadingParts: number;
};

export type VoxelWorldScene = VoxelGroup & {
  updateFocus: (focus: THREE.Vector3, camera?: THREE.PerspectiveCamera, viewportHeight?: number) => void;
  loadAround: (focus: THREE.Vector3, camera?: THREE.PerspectiveCamera, viewportHeight?: number) => Promise<void>;
  getDetailRadius: (focus: THREE.Vector3) => number;
  getResidentStats: () => VoxelWorldSceneStats;
};

export type VoxelWorldSceneOptions = {
  signal?: AbortSignal;
  onChange?: () => void;
  onError?: (message: string) => void;
  onProgress?: (progress: { processedBlocks: number; totalBlocks: number; stageLabel?: string } | null) => void;
  yieldAfterMs?: number;
  initialFocus?: THREE.Vector3;
  showOverview?: boolean;
  maxResidentPages?: number;
  maxUniformRegions?: number;
  maxMixedDetailRegions?: number;
  maxMixedProxyRegions?: number;
  mixedDetailRadius?: number;
  mixedProxyBlockLimit?: number;
};

type WorldCenter = { x: number; y: number; z: number };
type ResidentMixedRegion = { region: VoxelWorldMixedRegion; scale: number; voxelGroup: VoxelGroup };
type LoadingJob = { controller: AbortController; promise: Promise<void> };
type SceneView = {
  key: string;
  frustum: THREE.Frustum;
  projection: THREE.Matrix4;
  cameraInverse: THREE.Matrix4;
  cameraPosition: THREE.Vector3;
  cameraForward: THREE.Vector3;
  viewportHeight: number;
  fovRadians: number;
  cameraNear: number;
};
type RegionCandidate = {
  region: VoxelWorldRegion;
  distanceSq: number;
  visible: boolean;
  depth: number;
  viewScale: number;
};
type PageCandidate = { page: VoxelWorldRegionPageRef; distanceSq: number; visible: boolean; depth: number };
type ScenePlan = {
  key: string;
  regions: RegionCandidate[];
  pages: PageCandidate[];
  uniformRegions: VoxelWorldUniformRegion[];
  mixedRegions: Array<RegionCandidate & { region: VoxelWorldMixedRegion }>;
  desiredMixed: Map<string, number>;
  desiredPages: Set<number>;
};

const DEFAULT_MAX_RESIDENT_PAGES = 8;
const DEFAULT_MAX_UNIFORM_REGIONS = 256;
const DEFAULT_MAX_MIXED_DETAIL_REGIONS = 24;
const DEFAULT_MAX_MIXED_PROXY_REGIONS = 48;
const DEFAULT_CAMERA_MAX_MIXED_PROXY_REGIONS = 4096;
const DEFAULT_MIXED_PROXY_BLOCK_LIMIT = 1536;
const MIXED_LOAD_CONCURRENCY = 2;
const PAGE_LOAD_CONCURRENCY = 2;
const FOCUS_MOVE_THRESHOLD = 24;
const VIEW_FRUSTUM_PADDING = 64;
const VIEW_LOD_TARGET_PIXELS = 4;

const TINT_WHITE: [number, number, number] = [1, 1, 1];
const TINT_GRASS: [number, number, number] = [0.7, 1, 0.42];
const TINT_LEAVES: [number, number, number] = [0.45, 0.85, 0.28];
const TINT_WATER: [number, number, number] = [0.35, 0.55, 1];

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function clampInt(value: number | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback;
}

function worldCenterFromBounds(bounds: VoxelWorldBounds): WorldCenter {
  return {
    x: bounds.origin.x + bounds.size.x / 2,
    y: bounds.origin.y,
    z: bounds.origin.z + bounds.size.z / 2,
  };
}

function emptyBounds(): { box: THREE.Box3; center: THREE.Vector3; radius: number } {
  const origin = new THREE.Vector3(0, 0, 0);
  return { box: new THREE.Box3(origin.clone(), origin.clone()), center: origin, radius: 0.001 };
}

function boundsForWorld(bounds: VoxelWorldBounds | null): { box: THREE.Box3; center: THREE.Vector3; radius: number } {
  if (!bounds) return emptyBounds();
  const center = worldCenterFromBounds(bounds);
  const box = new THREE.Box3(
    new THREE.Vector3(
      bounds.origin.x - center.x,
      bounds.origin.y - center.y,
      bounds.origin.z - center.z,
    ),
    new THREE.Vector3(
      bounds.origin.x + bounds.size.x - center.x,
      bounds.origin.y + bounds.size.y - center.y,
      bounds.origin.z + bounds.size.z - center.z,
    ),
  );
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  return {
    box,
    center: box.getCenter(new THREE.Vector3()),
    radius: Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0.001,
  };
}

function endOf(bounds: VoxelWorldBounds): VoxelPoint {
  return {
    x: bounds.origin.x + bounds.size.x,
    y: bounds.origin.y + bounds.size.y,
    z: bounds.origin.z + bounds.size.z,
  };
}

function regionBounds(region: Pick<VoxelWorldRegion, "origin" | "size">): VoxelWorldBounds {
  return { origin: region.origin, size: region.size };
}

function distanceSqToBounds(bounds: VoxelWorldBounds, point: VoxelPoint): number {
  const end = endOf(bounds);
  const dx = point.x < bounds.origin.x ? bounds.origin.x - point.x : point.x > end.x ? point.x - end.x : 0;
  const dy = point.y < bounds.origin.y ? bounds.origin.y - point.y : point.y > end.y ? point.y - end.y : 0;
  const dz = point.z < bounds.origin.z ? bounds.origin.z - point.z : point.z > end.z ? point.z - end.z : 0;
  return dx * dx + dy * dy + dz * dz;
}

function sameFocus(a: VoxelPoint | null, b: VoxelPoint): boolean {
  if (!a) return false;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz < FOCUS_MOVE_THRESHOLD * FOCUS_MOVE_THRESHOLD;
}

function faceTint(blockType: string, face: Face): [number, number, number] {
  if (blockType === "oak_leaves") return TINT_LEAVES;
  if (blockType === "water") return TINT_WATER;
  if (blockType === "grass_block" && face === "up") return TINT_GRASS;
  return TINT_WHITE;
}

function materialKind(blockType: string): RenderKind {
  return getRenderKind(blockType) ?? "opaque";
}

function patchRepeatingAtlasMaterial(material: THREE.Material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <uv_pars_vertex>",
        "#include <uv_pars_vertex>\nattribute vec4 atlasUvFrame;\nvarying vec4 vAtlasUvFrame;",
      )
      .replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvAtlasUvFrame = atlasUvFrame;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <uv_pars_fragment>",
        "#include <uv_pars_fragment>\nvarying vec4 vAtlasUvFrame;",
      )
      .replace(
        "#include <map_fragment>",
        [
          "#ifdef USE_MAP",
          "  vec2 atlasTileUv = vAtlasUvFrame.xy + fract(vMapUv) * (vAtlasUvFrame.zw - vAtlasUvFrame.xy);",
          "  vec4 sampledDiffuseColor = texture2D(map, atlasTileUv);",
          "  diffuseColor *= sampledDiffuseColor;",
          "#endif",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => "voxel-world-repeating-atlas-v1";
}

function makeUniformMaterial(kind: RenderKind, atlasTexture: THREE.Texture): THREE.Material {
  const material =
    kind === "emissive"
      ? new THREE.MeshBasicMaterial({ map: atlasTexture, vertexColors: true })
      : new THREE.MeshLambertMaterial({
          map: atlasTexture,
          alphaTest: kind === "cutout" ? 0.45 : 0,
          transparent: kind === "transparent",
          opacity: kind === "transparent" ? 0.85 : 1,
          depthWrite: kind !== "transparent",
          vertexColors: true,
        });
  patchRepeatingAtlasMaterial(material);
  return material;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material.dispose();
  });
}

type UniformGeometryData = {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  atlasUvFrames: number[];
  indices: number[];
  vertexCount: number;
};

function makeUniformGeometryData(): UniformGeometryData {
  return {
    positions: [],
    normals: [],
    uvs: [],
    colors: [],
    atlasUvFrames: [],
    indices: [],
    vertexCount: 0,
  };
}

function appendUniformQuad(
  data: UniformGeometryData,
  verts: readonly (readonly [number, number, number])[],
  normal: readonly [number, number, number],
  tint: readonly [number, number, number],
  uvRepeat: readonly [number, number],
  atlasFrame: readonly [number, number, number, number],
) {
  const base = data.vertexCount;
  const uv: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, uvRepeat[1]],
    [uvRepeat[0], uvRepeat[1]],
    [uvRepeat[0], 0],
  ];

  for (let index = 0; index < 4; index += 1) {
    data.positions.push(verts[index][0], verts[index][1], verts[index][2]);
    data.normals.push(normal[0], normal[1], normal[2]);
    data.uvs.push(uv[index][0], uv[index][1]);
    data.colors.push(
      Math.round(tint[0] * 255),
      Math.round(tint[1] * 255),
      Math.round(tint[2] * 255),
    );
    data.atlasUvFrames.push(atlasFrame[0], atlasFrame[1], atlasFrame[2], atlasFrame[3]);
  }

  data.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  data.vertexCount += 4;
}

function buildGeometry(data: UniformGeometryData): THREE.BufferGeometry | null {
  if (data.indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(data.positions), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(data.normals), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(data.colors), 3, true));
  geometry.setAttribute("atlasUvFrame", new THREE.BufferAttribute(new Float32Array(data.atlasUvFrames), 4));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(data.indices), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function fullyOccludedByUniformNeighbor(
  region: VoxelWorldUniformRegion,
  face: Face,
  knownRegions: readonly VoxelWorldRegion[],
): boolean {
  const regionEnd = endOf(regionBounds(region));
  for (const candidate of knownRegions) {
    if (candidate.key === region.key || candidate.kind !== "uniform" || !isVoxelOccluder(candidate.type)) continue;
    const candidateEnd = endOf(regionBounds(candidate));
    const coversY = candidate.origin.y <= region.origin.y && candidateEnd.y >= regionEnd.y;
    const coversX = candidate.origin.x <= region.origin.x && candidateEnd.x >= regionEnd.x;
    const coversZ = candidate.origin.z <= region.origin.z && candidateEnd.z >= regionEnd.z;

    if (face === "east" && candidate.origin.x === regionEnd.x && coversY && coversZ) return true;
    if (face === "west" && candidateEnd.x === region.origin.x && coversY && coversZ) return true;
    if (face === "up" && candidate.origin.y === regionEnd.y && coversX && coversZ) return true;
    if (face === "down" && candidateEnd.y === region.origin.y && coversX && coversZ) return true;
    if (face === "south" && candidate.origin.z === regionEnd.z && coversX && coversY) return true;
    if (face === "north" && candidateEnd.z === region.origin.z && coversX && coversY) return true;
  }
  return false;
}

function appendUniformRegion(
  buckets: Map<RenderKind, UniformGeometryData>,
  region: VoxelWorldUniformRegion,
  center: WorldCenter,
  knownRegions: readonly VoxelWorldRegion[],
) {
  const kind = materialKind(region.type);
  const data = buckets.get(kind) ?? makeUniformGeometryData();
  buckets.set(kind, data);

  const x0 = region.origin.x - center.x;
  const y0 = region.origin.y - center.y;
  const z0 = region.origin.z - center.z;
  const x1 = x0 + region.size.x;
  const y1 = y0 + region.size.y;
  const z1 = z0 + region.size.z;
  const faces: Array<{
    face: Face;
    normal: readonly [number, number, number];
    verts: readonly (readonly [number, number, number])[];
    repeat: readonly [number, number];
  }> = [
    { face: "east", normal: [1, 0, 0], verts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], repeat: [region.size.z, region.size.y] },
    { face: "west", normal: [-1, 0, 0], verts: [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], repeat: [region.size.z, region.size.y] },
    { face: "north", normal: [0, 0, -1], verts: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], repeat: [region.size.x, region.size.y] },
    { face: "south", normal: [0, 0, 1], verts: [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], repeat: [region.size.x, region.size.y] },
    { face: "up", normal: [0, 1, 0], verts: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], repeat: [region.size.x, region.size.z] },
    { face: "down", normal: [0, -1, 0], verts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], repeat: [region.size.x, region.size.z] },
  ];

  for (const face of faces) {
    if (fullyOccludedByUniformNeighbor(region, face.face, knownRegions)) continue;
    const textureKey = getTextureKey(region.type, face.face);
    if (!hasAtlasKey(textureKey)) continue;
    const uv = getAtlasUv(textureKey);
    appendUniformQuad(
      data,
      face.verts,
      face.normal,
      faceTint(region.type, face.face),
      face.repeat,
      [uv.u0, uv.v0, uv.u1, uv.v1],
    );
  }
}

function buildUniformGroup(
  regions: readonly VoxelWorldUniformRegion[],
  center: WorldCenter,
  atlasTexture: THREE.Texture,
): THREE.Group | null {
  if (regions.length === 0) return null;
  configureAtlasTexture(atlasTexture);
  const buckets = new Map<RenderKind, UniformGeometryData>();
  for (const region of regions) appendUniformRegion(buckets, region, center, regions);

  const group = new THREE.Group();
  group.name = "VoxelWorldUniformRegions";
  for (const [kind, data] of buckets) {
    const geometry = buildGeometry(data);
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, makeUniformMaterial(kind, atlasTexture));
    if (kind === "transparent") mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group.children.length > 0 ? group : null;
}

async function inflatePart(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Compressed world parts are not supported by this browser.");
  }
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([body])
    .stream()
    .pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function readPartBytes(
  delivery: VoxelWorldDelivery,
  ref: VoxelWorldPartRef,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let encoded: Uint8Array;
  if (delivery.resolvePart) {
    encoded = await delivery.resolvePart(ref.key, signal);
  } else {
    if (ref.kind !== "opaque") throw new Error("Voxel world part is not available to this client.");
    if (typeof window === "undefined") throw new Error("Voxel world part fetch requires a browser.");
    const url = new URL(voxelWorldPartUrl(delivery, ref.key), window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("Voxel world part URL must be same-origin.");
    }
    const response = await fetch(url, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error(`World part request failed (${response.status})`);
    encoded = new Uint8Array(await response.arrayBuffer());
  }
  return ref.encoding === "gzip" && hasGzipMagic(encoded) ? inflatePart(encoded) : encoded;
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function packedAnchor(packed: PackedVoxelBlocks): WorldCenter {
  if (packed.count <= 0) return { x: 0, y: 0, z: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < packed.count; i += 1) {
    const x = packed.positions[i * 3];
    const y = packed.positions[i * 3 + 1];
    const z = packed.positions[i * 3 + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  return { x: (minX + maxX + 1) / 2, y: minY, z: (minZ + maxZ + 1) / 2 };
}

function focusFromLocal(local: THREE.Vector3, center: WorldCenter): VoxelPoint {
  return {
    x: local.x + center.x,
    y: local.y + center.y,
    z: local.z + center.z,
  };
}

function sortByDistance<T extends { distanceSq: number }>(a: T, b: T): number {
  return a.distanceSq - b.distanceSq;
}

function quantizedKey(value: number, step: number): string {
  return (Math.round(value / step) * step).toFixed(3);
}

function vectorKey(vector: THREE.Vector3, step: number): string {
  return [
    quantizedKey(vector.x, step),
    quantizedKey(vector.y, step),
    quantizedKey(vector.z, step),
  ].join(",");
}

function makeSceneView(camera?: THREE.PerspectiveCamera, viewportHeight?: number): SceneView | null {
  if (!camera || typeof viewportHeight !== "number" || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return null;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const cameraForward = camera.getWorldDirection(new THREE.Vector3()).normalize();
  return {
    key: [
      quantizedKey(viewportHeight, 1),
      quantizedKey(camera.getEffectiveFOV(), 0.005),
      quantizedKey(camera.aspect, 0.005),
      quantizedKey(camera.near, 1),
      quantizedKey(camera.far, 64),
      vectorKey(cameraPosition, 1),
      vectorKey(cameraForward, 0.005),
      vectorKey(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), 0.005),
    ].join("|"),
    frustum: new THREE.Frustum().setFromProjectionMatrix(matrix),
    projection: matrix,
    cameraInverse: camera.matrixWorldInverse.clone(),
    cameraPosition,
    cameraForward,
    viewportHeight,
    fovRadians: THREE.MathUtils.degToRad(camera.getEffectiveFOV()),
    cameraNear: camera.near,
  };
}

function localBounds(bounds: VoxelWorldBounds, center: WorldCenter): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(
      bounds.origin.x - center.x,
      bounds.origin.y - center.y,
      bounds.origin.z - center.z,
    ),
    new THREE.Vector3(
      bounds.origin.x + bounds.size.x - center.x,
      bounds.origin.y + bounds.size.y - center.y,
      bounds.origin.z + bounds.size.z - center.z,
    ),
  );
}

function closestCameraDepth(box: THREE.Box3, view: SceneView): number {
  if (box.containsPoint(view.cameraPosition)) return Math.max(0.001, view.cameraNear);
  const cameraSpace = new THREE.Vector3();
  let depth = Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        cameraSpace.set(x, y, z).applyMatrix4(view.cameraInverse);
        depth = Math.min(depth, -cameraSpace.z);
      }
    }
  }
  return Number.isFinite(depth) ? Math.max(depth, view.cameraNear) : Infinity;
}

function viewMetricsForBounds(bounds: VoxelWorldBounds, center: WorldCenter, view: SceneView | null) {
  if (!view) return { visible: false, depth: Infinity, viewScale: 1 };
  const box = localBounds(bounds, center);
  const visible = view.frustum.intersectsBox(box.clone().expandByScalar(VIEW_FRUSTUM_PADDING));
  const depth = visible ? closestCameraDepth(box, view) : Infinity;
  return { visible, depth, viewScale: viewScaleForDepth(depth, view) };
}

function viewScaleForDepth(depth: number, view: SceneView): number {
  if (!Number.isFinite(depth)) return 32;
  const targetWorldSize = 2 * Math.tan(view.fovRadians / 2) * depth * VIEW_LOD_TARGET_PIXELS / view.viewportHeight;
  let scale = 1;
  while (scale < 32 && scale * 2 <= targetWorldSize) scale *= 2;
  return scale;
}

function boundedProxyScale(region: VoxelWorldMixedRegion, limit: number): number {
  let scale = 2;
  while (
    scale < 32 &&
    Math.ceil(region.size.x / scale) * Math.ceil(region.size.y / scale) * Math.ceil(region.size.z / scale) > limit
  ) {
    scale *= 2;
  }
  return scale;
}

function clampScaledCoord(value: number, anchor: number, size: number, scale: number): number {
  return Math.min(size, Math.max(0, (value + anchor) * scale)) / scale - anchor;
}

function clampScaledGeometryToRegion(
  voxelGroup: VoxelGroup,
  region: VoxelWorldMixedRegion,
  anchor: WorldCenter,
  scale: number,
) {
  if (scale === 1) return;
  voxelGroup.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry.getAttribute("position");
    if (!position) return;
    for (let index = 0; index < position.count; index += 1) {
      position.setXYZ(
        index,
        clampScaledCoord(position.getX(index), anchor.x, region.size.x, scale),
        clampScaledCoord(position.getY(index), anchor.y, region.size.y, scale),
        clampScaledCoord(position.getZ(index), anchor.z, region.size.z, scale),
      );
    }
    position.needsUpdate = true;
    child.geometry.computeBoundingBox();
    child.geometry.computeBoundingSphere();
  });
}

class ManagedVoxelWorldScene implements VoxelWorldScene {
  readonly group = new THREE.Group();
  readonly bounds: { box: THREE.Box3; center: THREE.Vector3; radius: number };
  readonly stats: { blockCount: number };

  private readonly delivery: VoxelWorldDelivery;
  private readonly manifest: VoxelWorldManifest;
  private readonly palette: BlockDefinition[];
  private readonly atlasTexture: THREE.Texture;
  private readonly opts: Required<Omit<VoxelWorldSceneOptions, "signal" | "onChange" | "onError" | "onProgress" | "yieldAfterMs" | "mixedDetailRadius" | "initialFocus" | "showOverview">> & {
    signal?: AbortSignal;
    onChange?: () => void;
    onError?: (message: string) => void;
    onProgress?: VoxelWorldSceneOptions["onProgress"];
    yieldAfterMs?: number;
    mixedDetailRadius: number;
    cameraMaxMixedProxyRegions: number;
  };
  private readonly center: WorldCenter;
  private readonly regions = new Map<string, VoxelWorldRegion>();
  private readonly regionPages = new Map<number, VoxelWorldRegionPage>();
  private readonly residentMixed = new Map<string, ResidentMixedRegion>();
  private readonly loadingMixed = new Map<string, LoadingJob & { scale: number }>();
  private readonly loadingPages = new Map<number, LoadingJob>();
  private failure: Error | null = null;
  private uniformGroup: THREE.Group | null = null;
  private uniformRegionKey = "";
  private uniformRegionCount = 0;
  private overview: VoxelGroup | null = null;
  private readonly overviewController = new AbortController();
  private readonly detailFocus = { value: new THREE.Vector3() };
  private readonly detailRadius = { value: 0 };
  private readonly detailDirection = { value: new THREE.Vector3() };
  private readonly detailProjection = { value: new THREE.Matrix4() };
  private readonly detailRootInverse = { value: new THREE.Matrix4() };
  private readonly exactFocus = new THREE.Vector3();
  private exactRadius = 0;
  private mixedProxyRegions = 0;
  private mixedDetailRegions = 0;
  private focusWorld: VoxelPoint | null = null;
  private view: SceneView | null = null;
  private viewKey = "no-camera";
  private regionsRevision = 0;
  private planCache: ScenePlan | null = null;
  private disposed = false;

  constructor(
    delivery: VoxelWorldDelivery,
    manifest: VoxelWorldManifest,
    palette: BlockDefinition[],
    atlasTexture: THREE.Texture,
    opts: VoxelWorldSceneOptions = {},
  ) {
    this.delivery = delivery;
    this.manifest = manifest;
    this.palette = palette;
    this.atlasTexture = atlasTexture;
    this.bounds = boundsForWorld(manifest.bounds);
    this.stats = { blockCount: manifest.exactBlockCount };
    this.center = manifest.bounds ? worldCenterFromBounds(manifest.bounds) : { x: 0, y: 0, z: 0 };
    this.opts = {
      signal: opts.signal,
      onChange: opts.onChange,
      onError: opts.onError,
      onProgress: opts.onProgress,
      yieldAfterMs: opts.yieldAfterMs,
      maxResidentPages: clampInt(opts.maxResidentPages, DEFAULT_MAX_RESIDENT_PAGES, 1),
      maxUniformRegions: clampInt(opts.maxUniformRegions, DEFAULT_MAX_UNIFORM_REGIONS, 0),
      maxMixedDetailRegions: clampInt(opts.maxMixedDetailRegions, DEFAULT_MAX_MIXED_DETAIL_REGIONS, 0),
      maxMixedProxyRegions: clampInt(opts.maxMixedProxyRegions, manifest.overview ? 0 : DEFAULT_MAX_MIXED_PROXY_REGIONS, 0),
      cameraMaxMixedProxyRegions: clampInt(opts.maxMixedProxyRegions, DEFAULT_CAMERA_MAX_MIXED_PROXY_REGIONS, 0),
      mixedProxyBlockLimit: clampInt(opts.mixedProxyBlockLimit, DEFAULT_MIXED_PROXY_BLOCK_LIMIT, 1),
      mixedDetailRadius:
        typeof opts.mixedDetailRadius === "number" && Number.isFinite(opts.mixedDetailRadius)
          ? Math.max(0, opts.mixedDetailRadius)
          : Math.max(192, manifest.leafSize * 3),
    };
    this.group.name = "VoxelWorldScene";
    for (const region of manifest.regions ?? []) this.addRegion(region);
    opts.signal?.addEventListener("abort", () => this.dispose(), { once: true });
  }

  async loadOverview() {
    const overview = this.manifest.overview;
    if (!overview) return;
    const signal = this.overviewController.signal;
    this.opts.onProgress?.({ processedBlocks: 0, totalBlocks: 1, stageLabel: "Loading world" });
    const bytes = await readPartBytes(this.delivery, overview.data, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (readBinaryVoxelBuildHeader(bytes).blockCount > 1_000_000) throw new Error("World overview is too large");
    const packed = decodeBinaryVoxelBuild(bytes);
    const cellsPerAxis = this.manifest.gridSize / overview.scale;
    if (packed.positions.some((coordinate) => coordinate >= cellsPerAxis)) throw new Error("World overview exceeds its bounds");
    const anchor = packedAnchor(packed);
    const rendered = await createVoxelGroupAsync({ version: "1.0", blocks: [], packed }, this.palette, this.atlasTexture, {
      signal,
      onProgress: (progress) => this.opts.onProgress?.({ ...progress, stageLabel: "Loading world" }),
    });
    if (signal.aborted || this.disposed) {
      rendered.dispose();
      throw new DOMException("Aborted", "AbortError");
    }
    rendered.group.name = "VoxelWorldOverview";
    rendered.group.scale.setScalar(overview.scale);
    rendered.group.position.set(
      anchor.x * overview.scale - this.center.x,
      anchor.y * overview.scale - this.center.y,
      anchor.z * overview.scale - this.center.z,
    );
    rendered.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.userData.voxelWorldOverview = true;
      const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.allowOverride = false;
        material.onBeforeRender = (_renderer, scene) => {
          material.colorWrite = !scene.overrideMaterial;
          this.detailRootInverse.value.copy(this.group.matrixWorld).invert();
        };
        material.onBeforeCompile = (shader) => {
          shader.uniforms.worldDetailFocus = this.detailFocus;
          shader.uniforms.worldDetailRadius = this.detailRadius;
          shader.uniforms.worldDetailDirection = this.detailDirection;
          shader.uniforms.worldDetailProjection = this.detailProjection;
          shader.uniforms.worldDetailRootInverse = this.detailRootInverse;
          shader.vertexShader = `varying vec3 vWorldOverviewPosition;\nuniform mat4 worldDetailRootInverse;\n${shader.vertexShader}`
            .replace("#include <project_vertex>", "#include <project_vertex>\nvWorldOverviewPosition = (worldDetailRootInverse * modelMatrix * vec4(transformed, 1.0)).xyz;");
          shader.fragmentShader = `varying vec3 vWorldOverviewPosition;\nuniform vec3 worldDetailFocus;\nuniform float worldDetailRadius;\nuniform vec3 worldDetailDirection;\nuniform mat4 worldDetailProjection;\n${shader.fragmentShader}`
            .replace(
              "#include <clipping_planes_fragment>",
              "#include <clipping_planes_fragment>\nif (dot(worldDetailDirection, worldDetailDirection) > 0.0) {\n  vec4 detailClip = worldDetailProjection * vec4(vWorldOverviewPosition, 1.0);\n  if (all(lessThanEqual(abs(detailClip.xyz), vec3(detailClip.w))) && dot(vWorldOverviewPosition - worldDetailFocus, worldDetailDirection) < worldDetailRadius) discard;\n} else if (distance(vWorldOverviewPosition, worldDetailFocus) < worldDetailRadius) discard;",
            );
        };
        material.customProgramCacheKey = () => "voxel-world-overview-v2";
      }
    });
    this.overview = rendered;
    this.group.add(rendered.group);
  }

  updateFocus(focus: THREE.Vector3, camera?: THREE.PerspectiveCamera, viewportHeight?: number) {
    if (this.disposed || !this.manifest.bounds) return;
    const next = focusFromLocal(focus, this.center);
    const view = makeSceneView(camera, viewportHeight);
    const viewKey = view?.key ?? "no-camera";
    if (sameFocus(this.focusWorld, next) && this.viewKey === viewKey) return;
    this.reconcile(next, view, viewKey);
  }

  async loadAround(focus: THREE.Vector3, camera?: THREE.PerspectiveCamera, viewportHeight?: number): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.disposed || !this.manifest.bounds) return;
    this.reconcile(focusFromLocal(focus, this.center), makeSceneView(camera, viewportHeight), camera ? undefined : "no-camera");
    while (!this.disposed) {
      const pending = [...this.loadingPages.values(), ...this.loadingMixed.values()].map((job) => job.promise);
      if (pending.length === 0) break;
      await Promise.all(pending);
      if (this.failure) throw this.failure;
      if (this.focusWorld) this.reconcile(this.focusWorld, this.view, this.viewKey);
    }
  }

  getResidentStats(): VoxelWorldSceneStats {
    return {
      residentRegions: this.uniformRegionCount + this.residentMixed.size,
      uniformRegions: this.uniformRegionCount,
      mixedDetailRegions: this.mixedDetailRegions,
      mixedProxyRegions: this.mixedProxyRegions,
      residentRegionPages: this.regionPages.size,
      loadingParts: this.loadingPages.size + this.loadingMixed.size,
    };
  }

  getDetailRadius(focus: THREE.Vector3): number {
    return this.disposed ? 0 : Math.max(0, this.exactRadius - focus.distanceTo(this.exactFocus));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.overviewController.abort();
    for (const job of this.loadingPages.values()) job.controller.abort();
    for (const job of this.loadingMixed.values()) job.controller.abort();
    this.loadingPages.clear();
    this.loadingMixed.clear();
    if (this.uniformGroup) {
      this.group.remove(this.uniformGroup);
      disposeObject(this.uniformGroup);
      this.uniformGroup = null;
    }
    for (const resident of this.residentMixed.values()) {
      this.group.remove(resident.voxelGroup.group);
      resident.voxelGroup.dispose();
    }
    this.residentMixed.clear();
    if (this.overview) {
      this.group.remove(this.overview.group);
      this.overview.dispose();
      this.overview = null;
    }
  }

  private addRegion(region: VoxelWorldRegion) {
    if (!this.regions.has(region.key)) this.regionsRevision += 1;
    this.regions.set(region.key, region);
  }

  private reconcile(focusWorld: VoxelPoint, view: SceneView | null = this.view, viewKey = view?.key ?? "no-camera") {
    if (this.disposed || this.failure) return;
    this.focusWorld = focusWorld;
    this.view = view;
    this.viewKey = viewKey;
    let plan = this.scenePlan(focusWorld, view, viewKey);
    const evictedPages = this.loadPagesAround(plan);
    if (evictedPages || this.trimPageCache(plan)) plan = this.scenePlan(focusWorld, view, viewKey);
    this.rebuildUniformRegions(plan.uniformRegions);
    const progress = this.reconcileMixedRegions(plan);
    this.updateCoverage(plan, focusWorld, view);
    this.opts.onChange?.();
    this.opts.onProgress?.(progress.processedBlocks < progress.totalBlocks ? {
      ...progress,
      stageLabel: "Loading details",
    } : null);
  }

  private scenePlan(focusWorld: VoxelPoint, view: SceneView | null, viewKey: string): ScenePlan {
    const key = [
      this.regionsRevision,
      focusWorld.x.toFixed(3),
      focusWorld.y.toFixed(3),
      focusWorld.z.toFixed(3),
      viewKey,
    ].join("|");
    if (this.planCache?.key === key) return this.planCache;

    const regions = Array.from(this.regions.values())
      .map((region): RegionCandidate => {
        const bounds = regionBounds(region);
        return {
          region,
          distanceSq: distanceSqToBounds(bounds, focusWorld),
          ...viewMetricsForBounds(bounds, this.center, view),
        };
      })
      .sort((a, b) => view
        ? Number(b.visible) - Number(a.visible) || a.viewScale - b.viewScale || a.depth - b.depth || sortByDistance(a, b)
        : sortByDistance(a, b));

    const pages = (this.manifest.regionPages ?? [])
      .map((page): PageCandidate => ({
        page,
        distanceSq: distanceSqToBounds(page.bounds, focusWorld),
        ...viewMetricsForBounds(page.bounds, this.center, view),
      }))
      .sort((a, b) => view
        ? Number(b.visible) - Number(a.visible) || a.depth - b.depth || sortByDistance(a, b)
        : sortByDistance(a, b));

    const uniformRegions = regions
      .filter((candidate): candidate is RegionCandidate & { region: VoxelWorldUniformRegion } => candidate.region.kind === "uniform")
      .slice(0, this.opts.maxUniformRegions)
      .map((candidate) => candidate.region);
    const mixedRegions = regions.filter(
      (candidate): candidate is RegionCandidate & { region: VoxelWorldMixedRegion } => candidate.region.kind === "mixed",
    );
    const desiredPages = new Set(pages.slice(0, this.opts.maxResidentPages).map(({ page }) => page.index));
    const desiredMixed = view ? this.cameraDesiredMixedRegions(mixedRegions) : this.focusDesiredMixedRegions(mixedRegions);

    this.planCache = { key, regions, pages, uniformRegions, mixedRegions, desiredMixed, desiredPages };
    return this.planCache;
  }

  private focusDesiredMixedRegions(
    mixedRegions: readonly (RegionCandidate & { region: VoxelWorldMixedRegion })[],
  ): Map<string, number> {
    const desired = this.focusExactMixedRegions(mixedRegions);
    const maxResidentRegions = desired.size + this.opts.maxMixedProxyRegions;
    for (const candidate of mixedRegions) {
      if (desired.has(candidate.region.key) || desired.size >= maxResidentRegions) continue;
      desired.set(candidate.region.key, boundedProxyScale(candidate.region, this.opts.mixedProxyBlockLimit));
    }
    return desired;
  }

  private focusExactMixedRegions(
    mixedRegions: readonly (RegionCandidate & { region: VoxelWorldMixedRegion })[],
  ): Map<string, number> {
    const detailRadiusSq = this.opts.mixedDetailRadius * this.opts.mixedDetailRadius;
    const desired = new Map<string, number>();
    for (const candidate of mixedRegions) {
      if (desired.size >= this.opts.maxMixedDetailRegions) break;
      if (candidate.distanceSq <= detailRadiusSq || desired.size === 0) desired.set(candidate.region.key, 1);
    }
    return desired;
  }

  private cameraDesiredMixedRegions(
    mixedRegions: readonly (RegionCandidate & { region: VoxelWorldMixedRegion })[],
  ): Map<string, number> {
    const desired = this.focusExactMixedRegions(mixedRegions);
    let viewCount = 0;
    const overviewScale = this.manifest.overview?.scale ?? Infinity;

    for (const candidate of mixedRegions) {
      if (!candidate.visible || desired.has(candidate.region.key)) continue;
      const scale = candidate.viewScale;
      if (scale >= overviewScale) continue;
      if (viewCount >= this.opts.cameraMaxMixedProxyRegions) continue;
      viewCount += 1;
      desired.set(candidate.region.key, scale);
    }

    return desired;
  }

  private loadPagesAround(plan: ScenePlan): boolean {
    const pageRefs = this.manifest.regionPages;
    if (!pageRefs || pageRefs.length === 0) return false;
    let evicted = false;

    for (const index of this.regionPages.keys()) {
      if (!plan.desiredPages.has(index)) {
        this.evictPage(index);
        evicted = true;
      }
    }
    for (const [index, job] of this.loadingPages) {
      if (plan.desiredPages.has(index)) continue;
      job.controller.abort();
      this.loadingPages.delete(index);
    }

    const pages = plan.pages
      .filter(({ page }) => plan.desiredPages.has(page.index) && !this.regionPages.has(page.index) && !this.loadingPages.has(page.index))
      .slice(0, Math.max(0, PAGE_LOAD_CONCURRENCY - this.loadingPages.size));
    for (const { page } of pages) this.loadPage(page);
    return evicted;
  }

  private loadPage(page: VoxelWorldRegionPageRef) {
    const controller = new AbortController();
    const promise = this.readPage(page, controller.signal)
      .catch((error: unknown) => this.recordFailure(error))
      .finally(() => {
        if (this.loadingPages.get(page.index)?.controller === controller) this.loadingPages.delete(page.index);
        if (this.focusWorld) this.reconcile(this.focusWorld, this.view, this.viewKey);
      });
    this.loadingPages.set(page.index, { controller, promise });
  }

  private async readPage(page: VoxelWorldRegionPageRef, signal: AbortSignal) {
    const bytes = await readPartBytes(this.delivery, page.data, signal);
    if (signal.aborted || this.disposed) return;
    const parsed = parseVoxelWorldRegionPage(parseJsonBytes(bytes, "World region page"), {
      gridSize: this.manifest.gridSize,
      worldBounds: this.manifest.bounds,
      pageRef: page,
      allowLocalBlobRefs: Boolean(this.delivery.resolvePart),
    });
    if (!parsed.ok) throw new Error(parsed.error);
    this.regionPages.set(page.index, parsed.value);
    for (const region of parsed.value.regions) this.addRegion(region);
  }

  private trimPageCache(plan: ScenePlan): boolean {
    let evicted = false;
    while (this.regionPages.size > this.opts.maxResidentPages) {
      let farthest: { index: number; distanceSq: number } | null = null;
      for (const [index, page] of this.regionPages) {
        if (plan.desiredPages.has(index)) continue;
        const distanceSq = distanceSqToBounds(page.bounds, this.focusWorld ?? page.bounds.origin);
        if (!farthest || distanceSq > farthest.distanceSq) farthest = { index, distanceSq };
      }
      if (!farthest) return evicted;
      this.evictPage(farthest.index);
      evicted = true;
    }
    return evicted;
  }

  private evictPage(index: number) {
    const page = this.regionPages.get(index);
    this.regionPages.delete(index);
    let removedRegion = false;
    for (const region of page?.regions ?? []) {
      this.regions.delete(region.key);
      removedRegion = true;
      const resident = this.residentMixed.get(region.key);
      if (resident) {
        this.group.remove(resident.voxelGroup.group);
        resident.voxelGroup.dispose();
        this.residentMixed.delete(region.key);
      }
    }
    if (removedRegion) this.regionsRevision += 1;
  }

  private rebuildUniformRegions(regions: readonly VoxelWorldUniformRegion[]) {
    const key = regions.map((region) => region.key).sort().join("|");
    if (this.uniformRegionKey === key) return;
    if (this.uniformGroup) {
      this.group.remove(this.uniformGroup);
      disposeObject(this.uniformGroup);
      this.uniformGroup = null;
    }
    this.uniformRegionKey = key;
    this.uniformRegionCount = regions.length;
    const group = buildUniformGroup(regions, this.center, this.atlasTexture);
    if (!group) {
      this.opts.onChange?.();
      return;
    }
    this.uniformGroup = group;
    this.group.add(group);
    this.opts.onChange?.();
  }

  private reconcileMixedRegions(plan: ScenePlan) {
    const desired = plan.desiredMixed;
    for (const [key, resident] of this.residentMixed) {
      if (desired.has(key)) continue;
      this.group.remove(resident.voxelGroup.group);
      resident.voxelGroup.dispose();
      this.residentMixed.delete(key);
    }
    for (const [key, job] of this.loadingMixed) {
      if (desired.get(key) === job.scale) continue;
      job.controller.abort();
      this.loadingMixed.delete(key);
    }

    const activeLoads = this.loadingMixed.size;
    let loadSlots = Math.max(0, MIXED_LOAD_CONCURRENCY - activeLoads);
    for (const candidate of plan.mixedRegions) {
      if (loadSlots <= 0) break;
      const scale = desired.get(candidate.region.key);
      if (!scale) continue;
      const resident = this.residentMixed.get(candidate.region.key);
      if (resident?.scale === scale || this.loadingMixed.has(candidate.region.key)) continue;
      this.loadMixedRegion(candidate.region, scale);
      loadSlots -= 1;
    }

    this.mixedDetailRegions = 0;
    this.mixedProxyRegions = 0;
    for (const resident of this.residentMixed.values()) {
      if (resident.scale === 1) this.mixedDetailRegions += 1;
      else this.mixedProxyRegions += 1;
    }
    let processedBlocks = 0;
    let totalBlocks = 0;
    for (const { page } of plan.pages) {
      if (!plan.desiredPages.has(page.index)) continue;
      totalBlocks += page.blockCount;
      if (this.regionPages.has(page.index)) processedBlocks += page.blockCount;
    }
    for (const { region } of plan.mixedRegions) {
      const scale = desired.get(region.key);
      if (!scale) continue;
      totalBlocks += region.blockCount;
      const resident = this.residentMixed.get(region.key);
      if (resident && resident.scale <= scale) processedBlocks += region.blockCount;
    }
    return totalBlocks > 0
      ? { processedBlocks, totalBlocks }
      : { processedBlocks: 1, totalBlocks: 1 };
  }

  private updateCoverage(plan: ScenePlan, focusWorld: VoxelPoint, view: SceneView | null) {
    const uniformKeys = new Set(plan.uniformRegions.map((region) => region.key));
    let unknownDistanceSq = Infinity;
    for (const candidate of plan.regions) {
      const region = candidate.region;
      const detailed = region.kind === "uniform" ? uniformKeys.has(region.key) : this.residentMixed.get(region.key)?.scale === 1;
      if (!detailed) unknownDistanceSq = Math.min(unknownDistanceSq, candidate.distanceSq);
    }
    for (const candidate of plan.pages) {
      if (!this.regionPages.has(candidate.page.index)) unknownDistanceSq = Math.min(unknownDistanceSq, candidate.distanceSq);
    }

    this.exactFocus.set(focusWorld.x - this.center.x, focusWorld.y - this.center.y, focusWorld.z - this.center.z);
    this.exactRadius = Math.max(0, Math.sqrt(unknownDistanceSq) - 0.001);

    if (!view) {
      this.detailFocus.value.copy(this.exactFocus);
      this.detailDirection.value.set(0, 0, 0);
      this.detailRadius.value = Number.isFinite(unknownDistanceSq) ? this.exactRadius : 0;
      if (this.overview) this.overview.group.visible = Number.isFinite(unknownDistanceSq);
      return;
    }

    let coverageDepth = Infinity;
    for (const { page, visible, depth } of plan.pages) {
      if (visible && !this.regionPages.has(page.index)) coverageDepth = Math.min(coverageDepth, depth);
    }
    for (const candidate of plan.regions) {
      if (!candidate.visible) continue;
      const region = candidate.region;
      const covered = region.kind === "uniform"
        ? uniformKeys.has(region.key)
        : this.residentMixed.has(region.key);
      if (!covered) coverageDepth = Math.min(coverageDepth, candidate.depth);
    }

    this.detailFocus.value.copy(view.cameraPosition);
    this.detailDirection.value.copy(view.cameraForward);
    this.detailProjection.value.copy(view.projection);
    this.detailRadius.value = Number.isFinite(coverageDepth)
      ? Math.max(0, coverageDepth - 0.001)
      : view.cameraPosition.distanceTo(this.bounds.center) + this.bounds.radius + 64;
    if (this.overview) this.overview.group.visible = true;
  }

  private loadMixedRegion(region: VoxelWorldMixedRegion, scale: number) {
    const controller = new AbortController();
    const promise = this.readMixedRegion(region, scale, controller.signal)
      .catch((error: unknown) => this.recordFailure(error))
      .finally(() => {
        if (this.loadingMixed.get(region.key)?.controller === controller) this.loadingMixed.delete(region.key);
        if (this.focusWorld) this.reconcile(this.focusWorld, this.view, this.viewKey);
      });
    this.loadingMixed.set(region.key, { controller, promise, scale });
  }

  private async readMixedRegion(region: VoxelWorldMixedRegion, scale: number, signal: AbortSignal) {
    const bytes = await readPartBytes(this.delivery, region.data, signal);
    if (signal.aborted || this.disposed) return;
    const decoded = decodeBinaryVoxelBuild(bytes);
    if (decoded.count !== region.blockCount) throw new Error(`Voxel world region ${region.key} block count mismatch`);
    const packed = createWorldLodPackedBlocks(decoded, region.size, scale);
    const anchor = packedAnchor(packed);
    const build: RenderableVoxelBuild = { version: "1.0", blocks: [], packed };
    const voxelGroup = await createVoxelGroupAsync(build, this.palette, this.atlasTexture, {
      signal,
      yieldAfterMs: this.opts.yieldAfterMs,
    });
    if (signal.aborted || this.disposed) {
      voxelGroup.dispose();
      return;
    }
    clampScaledGeometryToRegion(voxelGroup, region, anchor, scale);
    voxelGroup.group.scale.setScalar(scale);
    voxelGroup.group.position.set(
      region.origin.x + anchor.x * scale - this.center.x,
      region.origin.y + anchor.y * scale - this.center.y,
      region.origin.z + anchor.z * scale - this.center.z,
    );
    const previous = this.residentMixed.get(region.key);
    if (previous) {
      this.group.remove(previous.voxelGroup.group);
      previous.voxelGroup.dispose();
    }
    this.residentMixed.set(region.key, { region, scale, voxelGroup });
    this.group.add(voxelGroup.group);
    this.opts.onChange?.();
  }

  private recordFailure(error: unknown) {
    if (isAbortError(error) || this.disposed || this.failure) return;
    const err = error instanceof Error ? error : new Error(String(error));
    this.failure = err;
    for (const job of this.loadingPages.values()) job.controller.abort();
    for (const job of this.loadingMixed.values()) job.controller.abort();
    this.opts.onError?.(err.message);
  }
}

export async function createVoxelWorldScene(
  delivery: VoxelWorldDelivery,
  palette: BlockDefinition[],
  atlasTexture: THREE.Texture,
  opts: VoxelWorldSceneOptions = {},
): Promise<VoxelWorldScene> {
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const parsed = parseVoxelWorldManifest(delivery.manifest, {
    allowLocalBlobRefs: Boolean(delivery.resolvePart),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const scene = new ManagedVoxelWorldScene(delivery, parsed.value, palette, atlasTexture, opts);
  try {
    const focus = opts.initialFocus ?? scene.bounds.center;
    if (parsed.value.overview && opts.showOverview !== false) {
      await scene.loadOverview();
      scene.updateFocus(focus);
    } else {
      await scene.loadAround(focus);
    }
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return scene;
  } catch (error) {
    scene.dispose();
    throw error;
  }
}

export function isVoxelWorldScene(group: VoxelGroup | null): group is VoxelWorldScene {
  return typeof (group as VoxelWorldScene | null)?.updateFocus === "function";
}
