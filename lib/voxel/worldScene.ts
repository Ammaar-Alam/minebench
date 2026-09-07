import * as THREE from "three";
import { getAtlasUv, hasAtlasKey } from "@/lib/blocks/atlas";
import type { BlockDefinition, RenderKind } from "@/lib/blocks/palettes";
import { getRenderKind } from "@/lib/blocks/registry";
import { getTextureKey, type Face } from "@/lib/blocks/textures";
import { decodeBinaryVoxelBuild, readBinaryVoxelBuildHeader } from "@/lib/voxel/binaryBuild";
import {
  configureAtlasTexture,
  createVoxelGroupAsync,
  createVoxelGroupFromMeshPayload,
  type VoxelGroup,
} from "@/lib/voxel/mesh";
import type { PackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type { VoxelPoint } from "@/lib/voxel/types";
import { createWorldMeshBatches, packWorldMeshBatch } from "@/lib/voxel/worldMeshSource";
import { decodeWorldMeshPayload, getWorldMeshVersion } from "@/lib/voxel/worldMesh";
import {
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  voxelWorldPartUrl,
  type VoxelWorldBounds,
  type VoxelWorldDelivery,
  type VoxelWorldPartRef,
  type VoxelWorldRegion,
  type VoxelWorldUniformRegion,
} from "@/lib/voxel/world";

export type VoxelWorldSceneStats = {
  residentRegions: number;
  uniformRegions: number;
  mixedRegions: number;
  residentRegionPages: number;
  meshBatches: number;
};

export type VoxelWorldScene = VoxelGroup & {
  getResidentStats: () => VoxelWorldSceneStats;
};

export type VoxelWorldSceneOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { processedBlocks: number; totalBlocks: number; stageLabel?: string } | null) => void;
};

type WorldCenter = { x: number; y: number; z: number };
const PART_LOAD_CONCURRENCY = 2;
const MESH_LOAD_CONCURRENCY = 4;

const TINT_WHITE: [number, number, number] = [1, 1, 1];
const TINT_GRASS: [number, number, number] = [0.7, 1, 0.42];
const TINT_LEAVES: [number, number, number] = [0.45, 0.85, 0.28];
const TINT_WATER: [number, number, number] = [0.35, 0.55, 1];

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
          "  vec2 atlasTileSpan = vAtlasUvFrame.zw - vAtlasUvFrame.xy;",
          "  vec2 atlasTileUv = vAtlasUvFrame.xy + fract(vMapUv) * atlasTileSpan;",
          "  vec4 sampledDiffuseColor = textureGrad(map, atlasTileUv, dFdx(vMapUv) * atlasTileSpan, dFdy(vMapUv) * atlasTileSpan);",
          "  diffuseColor *= sampledDiffuseColor;",
          "#endif",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => "voxel-world-repeating-atlas-v2";
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

export async function createVoxelWorldScene(
  delivery: VoxelWorldDelivery,
  palette: BlockDefinition[],
  atlasTexture: THREE.Texture,
  opts: VoxelWorldSceneOptions = {},
): Promise<VoxelWorldScene> {
  opts.signal?.throwIfAborted();
  const parsed = parseVoxelWorldManifest(delivery.manifest, {
    allowLocalBlobRefs: Boolean(delivery.resolvePart),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const manifest = parsed.value;
  const bounds = boundsForWorld(manifest.bounds);
  const center = manifest.bounds ? worldCenterFromBounds(manifest.bounds) : { x: 0, y: 0, z: 0 };
  const group = new THREE.Group();
  group.name = "VoxelWorldScene";
  const controller = new AbortController();
  const signal = controller.signal;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    opts.signal?.removeEventListener("abort", dispose);
    disposeObject(group);
    group.clear();
  };
  opts.signal?.addEventListener("abort", dispose, { once: true });
  let processedBlocks = 0;
  const progress = () => opts.onProgress?.({
    processedBlocks,
    totalBlocks: manifest.exactBlockCount,
    stageLabel: "Building world",
  });

  try {
    progress();
    signal.throwIfAborted();
    const regions = [...manifest.regions ?? []];
    const regionKeys = new Set(regions.map((region) => region.key));
    const pages = manifest.regionPages ?? [];
    for (let offset = 0; offset < pages.length; offset += PART_LOAD_CONCURRENCY) {
      signal.throwIfAborted();
      const loaded = await Promise.all(pages.slice(offset, offset + PART_LOAD_CONCURRENCY).map(async (page) => {
        const bytes = await readPartBytes(delivery, page.data, signal);
        signal.throwIfAborted();
        const parsedPage = parseVoxelWorldRegionPage(parseJsonBytes(bytes, "World region page"), {
          gridSize: manifest.gridSize,
          worldBounds: manifest.bounds,
          pageRef: page,
          allowLocalBlobRefs: Boolean(delivery.resolvePart),
        });
        if (!parsedPage.ok) throw new Error(parsedPage.error);
        return parsedPage.value;
      }));
      for (const page of loaded) {
        for (const region of page.regions) {
          if (regionKeys.has(region.key)) throw new Error(`Duplicate world region key: ${region.key}`);
          regionKeys.add(region.key);
          regions.push(region);
        }
      }
    }

    const uniformRegions = regions.filter((region): region is VoxelWorldUniformRegion => region.kind === "uniform");
    const uniformGroup = buildUniformGroup(uniformRegions, center, atlasTexture);
    if (uniformGroup) group.add(uniformGroup);
    processedBlocks = uniformRegions.reduce((sum, region) => sum + region.blockCount, 0);
    progress();

    const batches = createWorldMeshBatches(regions);
    const addBatch = (rendered: VoxelGroup, origin: VoxelPoint, anchor: WorldCenter, blockCount: number) => {
      if (signal.aborted) {
        rendered.dispose();
        signal.throwIfAborted();
      }
      rendered.group.name = "VoxelWorldMeshBatch";
      rendered.group.position.set(
        origin.x + anchor.x - center.x,
        origin.y + anchor.y - center.y,
        origin.z + anchor.z - center.z,
      );
      group.add(rendered.group);
      processedBlocks += blockCount;
      progress();
    };
    const preparedMesh = manifest.mesh && manifest.mesh.version === await getWorldMeshVersion() ? manifest.mesh : undefined;
    if (preparedMesh) {
      if (preparedMesh.batches.length !== batches.length || preparedMesh.batches.some((ref, index) => {
        const batch = batches[index];
        return ref.blockCount !== batch.regions.reduce((sum, region) => sum + region.blockCount, 0) ||
          (["x", "y", "z"] as const).some((axis) => ref.bounds.origin[axis] !== batch.bounds.origin[axis] || ref.bounds.size[axis] !== batch.bounds.size[axis]);
      })) throw new Error("World mesh batches do not match source regions");
      for (let offset = 0; offset < preparedMesh.batches.length; offset += MESH_LOAD_CONCURRENCY) {
        signal.throwIfAborted();
        await Promise.all(preparedMesh.batches.slice(offset, offset + MESH_LOAD_CONCURRENCY).map(async (ref) => {
          const bytes = await readPartBytes(delivery, ref.data, signal);
          signal.throwIfAborted();
          const payload = decodeWorldMeshPayload(bytes);
          const anchor = payload.worldQuads!.anchor;
          if (payload.filteredBlockCount > ref.blockCount || (["x", "y", "z"] as const).some((axis, index) =>
            payload.bounds.min[index] + anchor[index] < 0 || payload.bounds.max[index] + anchor[index] > ref.bounds.size[axis],
          )) throw new Error("World mesh payload is outside its source batch");
          addBatch(createVoxelGroupFromMeshPayload(payload, atlasTexture), ref.bounds.origin,
            { x: anchor[0], y: anchor[1], z: anchor[2] }, ref.blockCount);
        }));
      }
    } else for (const batch of batches) {
      signal.throwIfAborted();
      const sourceRegions = [...batch.regions, ...batch.neighbors.filter((region) => region.kind === "mixed")];
      const parts = new Map<string, PackedVoxelBlocks>();
      for (let offset = 0; offset < sourceRegions.length; offset += PART_LOAD_CONCURRENCY) {
        await Promise.all(sourceRegions.slice(offset, offset + PART_LOAD_CONCURRENCY).map(async (region) => {
          const bytes = await readPartBytes(delivery, region.data, signal);
          signal.throwIfAborted();
          if (readBinaryVoxelBuildHeader(bytes).blockCount !== region.blockCount) {
            throw new Error(`Voxel world region ${region.key} block count mismatch`);
          }
          parts.set(region.key, decodeBinaryVoxelBuild(bytes));
        }));
      }
      signal.throwIfAborted();
      const { packed, halo } = packWorldMeshBatch(batch, parts);
      parts.clear();
      const anchor = packedAnchor(packed);
      const rendered = await createVoxelGroupAsync({ version: "1.0", blocks: [], packed }, palette, atlasTexture, {
        signal,
        worldRegion: { size: batch.bounds.size, halo },
      });
      addBatch(rendered, batch.bounds.origin, anchor, packed.count);
    }
    signal.throwIfAborted();
    opts.onProgress?.(null);
    signal.throwIfAborted();
    return {
      group,
      bounds,
      stats: { blockCount: manifest.exactBlockCount },
      getResidentStats: () => ({
        residentRegions: disposed ? 0 : regions.length,
        uniformRegions: disposed ? 0 : uniformRegions.length,
        mixedRegions: disposed ? 0 : regions.length - uniformRegions.length,
        residentRegionPages: disposed ? 0 : pages.length,
        meshBatches: disposed ? 0 : batches.length,
      }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function isVoxelWorldScene(group: VoxelGroup | null): group is VoxelWorldScene {
  return typeof (group as VoxelWorldScene | null)?.getResidentStats === "function";
}
