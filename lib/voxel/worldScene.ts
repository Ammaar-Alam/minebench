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
  createPackedVoxelBlocks,
  type PackedVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type { VoxelPoint } from "@/lib/voxel/types";
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
  updateFocus: (focus: THREE.Vector3) => void;
  loadAround: (focus: THREE.Vector3) => Promise<void>;
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
type ResidentMixedRegion = { region: VoxelWorldMixedRegion; mode: "detail" | "proxy"; voxelGroup: VoxelGroup };
type LoadingJob = { controller: AbortController; promise: Promise<void> };
type RegionCandidate = { region: VoxelWorldRegion; distanceSq: number };
type PageCandidate = { page: VoxelWorldRegionPageRef; distanceSq: number };

const DEFAULT_MAX_RESIDENT_PAGES = 8;
const DEFAULT_MAX_UNIFORM_REGIONS = 256;
const DEFAULT_MAX_MIXED_DETAIL_REGIONS = 24;
const DEFAULT_MAX_MIXED_PROXY_REGIONS = 48;
const DEFAULT_MIXED_PROXY_BLOCK_LIMIT = 1536;
const MIXED_LOAD_CONCURRENCY = 2;
const PAGE_LOAD_CONCURRENCY = 2;
const FOCUS_MOVE_THRESHOLD = 24;

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

function samplePackedBlocks(packed: PackedVoxelBlocks, limit: number): PackedVoxelBlocks {
  if (packed.count <= limit) return packed;
  const count = Math.max(1, Math.min(packed.count, limit));
  const stride = Math.max(1, Math.ceil(packed.count / count));
  const sampled = createPackedVoxelBlocks(count);
  sampled.typeNames = packed.typeNames.slice();
  let write = 0;
  for (let read = 0; read < packed.count && write < count; read += stride) {
    sampled.positions[write * 3] = packed.positions[read * 3];
    sampled.positions[write * 3 + 1] = packed.positions[read * 3 + 1];
    sampled.positions[write * 3 + 2] = packed.positions[read * 3 + 2];
    sampled.typeIds[write] = packed.typeIds[read];
    write += 1;
  }
  sampled.count = write;
  return sampled;
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
  };
  private readonly center: WorldCenter;
  private readonly regions = new Map<string, VoxelWorldRegion>();
  private readonly regionPages = new Map<number, VoxelWorldRegionPage>();
  private readonly residentMixed = new Map<string, ResidentMixedRegion>();
  private readonly loadingMixed = new Map<string, LoadingJob & { mode: ResidentMixedRegion["mode"] }>();
  private readonly loadingPages = new Map<number, LoadingJob>();
  private failure: Error | null = null;
  private uniformGroup: THREE.Group | null = null;
  private uniformRegionKey = "";
  private uniformRegionCount = 0;
  private overview: VoxelGroup | null = null;
  private readonly overviewController = new AbortController();
  private readonly detailFocus = { value: new THREE.Vector3() };
  private readonly detailRadius = { value: 0 };
  private mixedProxyRegions = 0;
  private mixedDetailRegions = 0;
  private focusWorld: VoxelPoint | null = null;
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
        material.onBeforeRender = (_renderer, scene) => { material.colorWrite = !scene.overrideMaterial; };
        material.onBeforeCompile = (shader) => {
          shader.uniforms.worldDetailFocus = this.detailFocus;
          shader.uniforms.worldDetailRadius = this.detailRadius;
          shader.vertexShader = `varying vec3 vWorldOverviewPosition;\n${shader.vertexShader}`
            .replace("#include <project_vertex>", "#include <project_vertex>\nvWorldOverviewPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
          shader.fragmentShader = `varying vec3 vWorldOverviewPosition;\nuniform vec3 worldDetailFocus;\nuniform float worldDetailRadius;\n${shader.fragmentShader}`
            .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (distance(vWorldOverviewPosition, worldDetailFocus) < worldDetailRadius) discard;");
        };
        material.customProgramCacheKey = () => "voxel-world-overview-v1";
      }
    });
    this.overview = rendered;
    this.group.add(rendered.group);
  }

  updateFocus(focus: THREE.Vector3) {
    if (this.disposed || !this.manifest.bounds) return;
    const next = focusFromLocal(focus, this.center);
    if (sameFocus(this.focusWorld, next)) return;
    this.reconcile(next);
  }

  async loadAround(focus: THREE.Vector3): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.disposed || !this.manifest.bounds) return;
    this.reconcile(focusFromLocal(focus, this.center));
    while (!this.disposed) {
      const pending = [...this.loadingPages.values(), ...this.loadingMixed.values()].map((job) => job.promise);
      if (pending.length === 0) break;
      await Promise.all(pending);
      if (this.failure) throw this.failure;
      if (this.focusWorld) this.reconcile(this.focusWorld);
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
    return this.disposed ? 0 : Math.max(0, this.detailRadius.value - focus.distanceTo(this.detailFocus.value));
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
    this.regions.set(region.key, region);
  }

  private reconcile(focusWorld: VoxelPoint) {
    if (this.disposed || this.failure) return;
    this.focusWorld = focusWorld;
    this.loadPagesAround(focusWorld);
    this.trimPageCache(focusWorld);

    const candidates = Array.from(this.regions.values())
      .map((region): RegionCandidate => ({ region, distanceSq: distanceSqToBounds(regionBounds(region), focusWorld) }))
      .sort(sortByDistance);

    const uniformRegions = candidates
      .filter((candidate): candidate is RegionCandidate & { region: VoxelWorldUniformRegion } => candidate.region.kind === "uniform")
      .slice(0, this.opts.maxUniformRegions)
      .map((candidate) => candidate.region);
    const mixedRegions = candidates.filter(
      (candidate): candidate is RegionCandidate & { region: VoxelWorldMixedRegion } => candidate.region.kind === "mixed",
    );

    this.rebuildUniformRegions(uniformRegions);
    const progress = this.reconcileMixedRegions(mixedRegions);
    const uniformKeys = new Set(uniformRegions.map((region) => region.key));
    let unknownDistanceSq = Infinity;
    for (const candidate of candidates) {
      const region = candidate.region;
      const detailed = region.kind === "uniform" ? uniformKeys.has(region.key) : this.residentMixed.get(region.key)?.mode === "detail";
      if (!detailed) unknownDistanceSq = Math.min(unknownDistanceSq, candidate.distanceSq);
    }
    for (const page of this.manifest.regionPages ?? []) {
      if (!this.regionPages.has(page.index)) unknownDistanceSq = Math.min(unknownDistanceSq, distanceSqToBounds(page.bounds, focusWorld));
    }
    this.detailFocus.value.set(focusWorld.x - this.center.x, focusWorld.y - this.center.y, focusWorld.z - this.center.z);
    this.detailRadius.value = Math.max(0, Math.sqrt(unknownDistanceSq) - 0.001);
    if (this.overview) this.overview.group.visible = Number.isFinite(unknownDistanceSq);
    this.opts.onChange?.();
    this.opts.onProgress?.(this.loadingPages.size + this.loadingMixed.size > 0 ? {
      ...progress,
      stageLabel: "Loading details",
    } : null);
  }

  private loadPagesAround(focusWorld: VoxelPoint) {
    const pageRefs = this.manifest.regionPages;
    if (!pageRefs || pageRefs.length === 0) return;
    const candidates = pageRefs
      .map((page): PageCandidate => ({ page, distanceSq: distanceSqToBounds(page.bounds, focusWorld) }))
      .sort(sortByDistance);
    const desired = new Set(candidates.slice(0, this.opts.maxResidentPages).map(({ page }) => page.index));

    for (const index of this.regionPages.keys()) {
      if (!desired.has(index)) this.evictPage(index);
    }
    for (const [index, job] of this.loadingPages) {
      if (desired.has(index)) continue;
      job.controller.abort();
      this.loadingPages.delete(index);
    }

    const pages = candidates
      .filter(({ page }) => desired.has(page.index) && !this.regionPages.has(page.index) && !this.loadingPages.has(page.index))
      .slice(0, Math.max(0, PAGE_LOAD_CONCURRENCY - this.loadingPages.size));
    for (const { page } of pages) this.loadPage(page);
  }

  private loadPage(page: VoxelWorldRegionPageRef) {
    const controller = new AbortController();
    const promise = this.readPage(page, controller.signal)
      .catch((error: unknown) => this.recordFailure(error))
      .finally(() => {
        if (this.loadingPages.get(page.index)?.controller === controller) this.loadingPages.delete(page.index);
        if (this.focusWorld) this.reconcile(this.focusWorld);
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

  private trimPageCache(focusWorld: VoxelPoint) {
    while (this.regionPages.size > this.opts.maxResidentPages) {
      let farthest: { index: number; distanceSq: number } | null = null;
      for (const [index, page] of this.regionPages) {
        const distanceSq = distanceSqToBounds(page.bounds, focusWorld);
        if (!farthest || distanceSq > farthest.distanceSq) farthest = { index, distanceSq };
      }
      if (!farthest) return;
      this.evictPage(farthest.index);
    }
  }

  private evictPage(index: number) {
    const page = this.regionPages.get(index);
    this.regionPages.delete(index);
    for (const region of page?.regions ?? []) {
      this.regions.delete(region.key);
      const resident = this.residentMixed.get(region.key);
      if (resident) {
        this.group.remove(resident.voxelGroup.group);
        resident.voxelGroup.dispose();
        this.residentMixed.delete(region.key);
      }
    }
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

  private reconcileMixedRegions(
    mixedRegions: readonly (RegionCandidate & { region: VoxelWorldMixedRegion })[],
  ) {
    const detailRadiusSq = this.opts.mixedDetailRadius * this.opts.mixedDetailRadius;
    const desired = new Map<string, "detail" | "proxy">();
    for (const candidate of mixedRegions) {
      if (desired.size >= this.opts.maxMixedDetailRegions) break;
      if (candidate.distanceSq <= detailRadiusSq || desired.size === 0) desired.set(candidate.region.key, "detail");
    }
    const maxResidentRegions = desired.size + this.opts.maxMixedProxyRegions;
    for (const candidate of mixedRegions) {
      if (desired.has(candidate.region.key) || desired.size >= maxResidentRegions) continue;
      desired.set(candidate.region.key, "proxy");
    }

    for (const [key, resident] of this.residentMixed) {
      const mode = desired.get(key);
      if (mode === resident.mode || (resident.mode === "proxy" && mode === "detail")) continue;
      this.group.remove(resident.voxelGroup.group);
      resident.voxelGroup.dispose();
      this.residentMixed.delete(key);
    }
    for (const [key, job] of this.loadingMixed) {
      if (desired.get(key) === job.mode) continue;
      job.controller.abort();
      this.loadingMixed.delete(key);
    }

    const activeLoads = this.loadingMixed.size;
    let loadSlots = Math.max(0, MIXED_LOAD_CONCURRENCY - activeLoads);
    for (const candidate of mixedRegions) {
      if (loadSlots <= 0) break;
      const mode = desired.get(candidate.region.key);
      if (!mode) continue;
      const resident = this.residentMixed.get(candidate.region.key);
      if (resident?.mode === mode || this.loadingMixed.has(candidate.region.key)) continue;
      this.loadMixedRegion(candidate.region, mode);
      loadSlots -= 1;
    }

    this.mixedDetailRegions = 0;
    this.mixedProxyRegions = 0;
    for (const resident of this.residentMixed.values()) {
      if (resident.mode === "detail") this.mixedDetailRegions += 1;
      else this.mixedProxyRegions += 1;
    }
    let processedBlocks = 0;
    let totalBlocks = 0;
    for (const { region } of mixedRegions) {
      const mode = desired.get(region.key);
      if (!mode) continue;
      totalBlocks += region.blockCount;
      if (this.residentMixed.get(region.key)?.mode === mode) processedBlocks += region.blockCount;
    }
    return { processedBlocks, totalBlocks: Math.max(1, totalBlocks) };
  }

  private loadMixedRegion(region: VoxelWorldMixedRegion, mode: "detail" | "proxy") {
    const controller = new AbortController();
    const promise = this.readMixedRegion(region, mode, controller.signal)
      .catch((error: unknown) => this.recordFailure(error))
      .finally(() => {
        if (this.loadingMixed.get(region.key)?.controller === controller) this.loadingMixed.delete(region.key);
        if (this.focusWorld) this.reconcile(this.focusWorld);
      });
    this.loadingMixed.set(region.key, { controller, promise, mode });
  }

  private async readMixedRegion(region: VoxelWorldMixedRegion, mode: "detail" | "proxy", signal: AbortSignal) {
    const bytes = await readPartBytes(this.delivery, region.data, signal);
    if (signal.aborted || this.disposed) return;
    const decoded = decodeBinaryVoxelBuild(bytes);
    if (decoded.count !== region.blockCount) throw new Error(`Voxel world region ${region.key} block count mismatch`);
    const packed = mode === "proxy" ? samplePackedBlocks(decoded, this.opts.mixedProxyBlockLimit) : decoded;
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
    voxelGroup.group.position.set(
      region.origin.x + anchor.x - this.center.x,
      region.origin.y + anchor.y - this.center.y,
      region.origin.z + anchor.z - this.center.z,
    );
    const previous = this.residentMixed.get(region.key);
    if (previous) {
      this.group.remove(previous.voxelGroup.group);
      previous.voxelGroup.dispose();
    }
    this.residentMixed.set(region.key, { region, mode, voxelGroup });
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
