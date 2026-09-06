import { z } from "zod";

export const VOXEL_WORLD_MANIFEST_VERSION = 1;
export const VOXEL_WORLD_EVALUATOR_VERSION = 1;
export const VOXEL_WORLD_MAX_GRID_SIZE = 8192;
export const VOXEL_WORLD_MIXED_LEAF_SIZE = 64;
export const VOXEL_WORLD_INLINE_REGION_LIMIT = 512;
export const VOXEL_WORLD_REGION_PAGE_LIMIT = 2048;
export const VOXEL_WORLD_REGION_PAGE_REF_LIMIT = 4096;

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = countSchema.min(1);
const paletteSchema = z.enum(["simple", "advanced"]);
const encodingSchema = z.enum(["gzip", "identity"]);
const sourceFormatSchema = z.enum(["build_json", "voxel-build-json"]);
const keySchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sha256Schema = z.string().trim().regex(/^[a-fA-F0-9]{64}$/);
const xyz = <T extends z.ZodTypeAny>(schema: T) => z.object({ x: schema, y: schema, z: schema }).strict();
const pointSchema = xyz(z.number().int().min(0).max(VOXEL_WORLD_MAX_GRID_SIZE - 1));
const sizePointSchema = xyz(z.number().int().min(1).max(VOXEL_WORLD_MAX_GRID_SIZE));
const boundsSchema = z.object({ origin: pointSchema, size: sizePointSchema }).strict();

const partBaseSchema = z.object({ key: keySchema, encoding: encodingSchema, byteSize: positiveCountSchema });
const storedPartRefSchema = partBaseSchema.extend({
  kind: z.literal("stored"),
  bucket: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  path: z.string().trim().min(1).max(2048).refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.includes("://") && !path.includes("?") && !path.includes("#"),
    "stored part path must be a storage key",
  ),
  sha256: sha256Schema,
}).strict();
const opaquePartRefSchema = partBaseSchema.extend({ kind: z.literal("opaque"), sha256: sha256Schema }).strict();
const localBlobPartRefSchema = partBaseSchema.extend({ kind: z.literal("localBlob"), sha256: sha256Schema.optional() }).strict();
const partRefSchema = z.discriminatedUnion("kind", [storedPartRefSchema, opaquePartRefSchema, localBlobPartRefSchema]);

const regionBaseSchema = z.object({ key: keySchema, origin: pointSchema, size: sizePointSchema, blockCount: positiveCountSchema });
const uniformRegionSchema = regionBaseSchema.extend({ kind: z.literal("uniform"), type: z.string().trim().min(1).max(128) }).strict();
const mixedRegionSchema = regionBaseSchema.extend({
  kind: z.literal("mixed"),
  format: z.literal("mbv4"),
  coordinateSpace: z.literal("local"),
  data: partRefSchema,
}).strict();
const regionSchema = z.discriminatedUnion("kind", [uniformRegionSchema, mixedRegionSchema]);
const regionPageRefSchema = z.object({
  index: countSchema.max(VOXEL_WORLD_REGION_PAGE_REF_LIMIT - 1),
  bounds: boundsSchema,
  regionCount: positiveCountSchema.max(VOXEL_WORLD_REGION_PAGE_LIMIT),
  blockCount: positiveCountSchema,
  data: partRefSchema,
}).strict();
const sourceSchema = z.object({ format: sourceFormatSchema, sha256: sha256Schema, evaluatorVersion: positiveCountSchema }).strict();
const manifestSchema = z.object({
  kind: z.literal("voxel_world"),
  version: z.literal(VOXEL_WORLD_MANIFEST_VERSION),
  gridSize: positiveCountSchema.max(VOXEL_WORLD_MAX_GRID_SIZE),
  palette: paletteSchema,
  bounds: boundsSchema.nullable(),
  exactBlockCount: countSchema,
  leafSize: z.literal(VOXEL_WORLD_MIXED_LEAF_SIZE),
  source: sourceSchema,
  regions: z.array(regionSchema).max(VOXEL_WORLD_INLINE_REGION_LIMIT, "regions has too many entries").optional(),
  regionPages: z.array(regionPageRefSchema).max(VOXEL_WORLD_REGION_PAGE_REF_LIMIT, "regionPages has too many entries").optional(),
}).strict();
const regionPageSchema = z.object({
  kind: z.literal("voxel_world_region_page"),
  version: z.literal(VOXEL_WORLD_MANIFEST_VERSION),
  index: countSchema.max(VOXEL_WORLD_REGION_PAGE_REF_LIMIT - 1),
  bounds: boundsSchema,
  regionCount: positiveCountSchema.max(VOXEL_WORLD_REGION_PAGE_LIMIT),
  blockCount: positiveCountSchema,
  regions: z.array(regionSchema).max(VOXEL_WORLD_REGION_PAGE_LIMIT, "regions has too many entries"),
}).strict();

export type VoxelWorldPalette = z.infer<typeof paletteSchema>;
export type VoxelWorldPartEncoding = z.infer<typeof encodingSchema>;
export type VoxelWorldBounds = z.infer<typeof boundsSchema>;
export type StoredVoxelWorldPartRef = z.infer<typeof storedPartRefSchema>;
export type OpaqueVoxelWorldPartRef = z.infer<typeof opaquePartRefSchema>;
export type LocalBlobVoxelWorldPartRef = z.infer<typeof localBlobPartRefSchema>;
export type VoxelWorldPartRef = z.infer<typeof partRefSchema>;
export type VoxelWorldUniformRegion = z.infer<typeof uniformRegionSchema>;
export type VoxelWorldMixedRegion = z.infer<typeof mixedRegionSchema>;
export type VoxelWorldRegion = z.infer<typeof regionSchema>;
export type VoxelWorldRegionPageRef = z.infer<typeof regionPageRefSchema>;
export type VoxelWorldSource = z.infer<typeof sourceSchema>;
export type VoxelWorldManifest = z.infer<typeof manifestSchema>;
export type VoxelWorldRegionPage = z.infer<typeof regionPageSchema>;
export type VoxelWorldPartResolver = (key: string, signal?: AbortSignal) => Promise<Uint8Array>;
export type VoxelWorldDelivery = { manifest: VoxelWorldManifest; partBaseUrl?: string; resolvePart?: VoxelWorldPartResolver };
export type VoxelWorldParseOptions = { allowStoredRefs?: boolean; allowLocalBlobRefs?: boolean };
export type VoxelWorldRegionPageParseOptions = VoxelWorldParseOptions & {
  gridSize?: number;
  worldBounds?: VoxelWorldBounds | null;
  pageRef?: VoxelWorldRegionPageRef;
};
export type VoxelWorldManifestParseResult = { ok: true; value: VoxelWorldManifest } | { ok: false; error: string };
export type VoxelWorldRegionPageParseResult = { ok: true; value: VoxelWorldRegionPage } | { ok: false; error: string };

type RefPolicy = Required<VoxelWorldParseOptions>;
type ValidationContext = {
  gridSize: number;
  bounds: VoxelWorldBounds | null;
  policy: RefPolicy;
  regionKeys: Set<string>;
  partRefs: Map<string, string>;
  pagePartKeys: Set<string>;
};

function volume(bounds: VoxelWorldBounds): number {
  return bounds.size.x * bounds.size.y * bounds.size.z;
}

function end(bounds: VoxelWorldBounds) {
  return { x: bounds.origin.x + bounds.size.x, y: bounds.origin.y + bounds.size.y, z: bounds.origin.z + bounds.size.z };
}

function contains(outer: VoxelWorldBounds, inner: VoxelWorldBounds): boolean {
  const a = end(outer);
  const b = end(inner);
  return inner.origin.x >= outer.origin.x && inner.origin.y >= outer.origin.y && inner.origin.z >= outer.origin.z && b.x <= a.x && b.y <= a.y && b.z <= a.z;
}

function sameBounds(a: VoxelWorldBounds, b: VoxelWorldBounds): boolean {
  return contains(a, b) && contains(b, a);
}

function regionBox(region: Pick<VoxelWorldRegion, "origin" | "size">): VoxelWorldBounds {
  return { origin: region.origin, size: region.size };
}

function fitsGrid(bounds: VoxelWorldBounds, gridSize: number): boolean {
  const boundsEnd = end(bounds);
  return boundsEnd.x <= gridSize && boundsEnd.y <= gridSize && boundsEnd.z <= gridSize;
}

function refPolicy(opts: VoxelWorldParseOptions): RefPolicy {
  return { allowStoredRefs: Boolean(opts.allowStoredRefs), allowLocalBlobRefs: Boolean(opts.allowLocalBlobRefs) };
}

function zodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? error.message;
}

function partRefSignature(ref: VoxelWorldPartRef): string {
  return `${ref.kind}:${ref.encoding}:${ref.byteSize}:${"sha256" in ref ? ref.sha256 ?? "" : ""}`;
}

function checkPartRef(
  ref: VoxelWorldPartRef,
  ctx: Pick<ValidationContext, "policy" | "partRefs" | "pagePartKeys">,
  opts: { allowDuplicateSameRef?: boolean } = {},
) {
  if (ref.kind === "stored" && !ctx.policy.allowStoredRefs) throw new Error("Stored world part refs are server-only");
  if (ref.kind === "localBlob" && !ctx.policy.allowLocalBlobRefs) throw new Error("Local blob world part refs are local-only");

  if (!opts.allowDuplicateSameRef) {
    if (ctx.pagePartKeys.has(ref.key)) throw new Error(`Duplicate world part key: ${ref.key}`);
    ctx.pagePartKeys.add(ref.key);
    return;
  }

  const signature = partRefSignature(ref);
  const existing = ctx.partRefs.get(ref.key);
  if (existing && existing !== signature) throw new Error(`Conflicting world part key: ${ref.key}`);
  ctx.partRefs.set(ref.key, signature);
}

function checkRegion(region: VoxelWorldRegion, ctx: ValidationContext) {
  if (ctx.regionKeys.has(region.key)) throw new Error(`Duplicate world region key: ${region.key}`);
  ctx.regionKeys.add(region.key);
  const bounds = regionBox(region);
  if (!fitsGrid(bounds, ctx.gridSize) || (ctx.bounds && !contains(ctx.bounds, bounds))) throw new Error(`${region.key} is outside the world bounds`);
  const boundsVolume = volume(bounds);
  if (region.kind === "uniform") {
    if (region.blockCount !== boundsVolume) throw new Error(`${region.key} blockCount must equal its volume`);
    return;
  }
  if (region.size.x > VOXEL_WORLD_MIXED_LEAF_SIZE || region.size.y > VOXEL_WORLD_MIXED_LEAF_SIZE || region.size.z > VOXEL_WORLD_MIXED_LEAF_SIZE) {
    throw new Error(`${region.key} exceeds the mixed leaf size`);
  }
  if (region.blockCount > boundsVolume) throw new Error(`${region.key} blockCount exceeds its volume`);
  checkPartRef(region.data, ctx, { allowDuplicateSameRef: true });
}

function checkedSum(items: readonly { blockCount: number }[], max: number, label: string): number {
  return items.reduce((sum, item) => {
    const next = sum + item.blockCount;
    if (!Number.isSafeInteger(next) || next > max) throw new Error(`${label} exceeds the world volume`);
    return next;
  }, 0);
}

function newContext(gridSize: number, bounds: VoxelWorldBounds | null, opts: VoxelWorldParseOptions): ValidationContext {
  return {
    gridSize,
    bounds,
    policy: refPolicy(opts),
    regionKeys: new Set(),
    partRefs: new Map(),
    pagePartKeys: new Set(),
  };
}

function checkPageRef(page: VoxelWorldRegionPageRef, ctx: ValidationContext, pageIndexes: Set<number>) {
  if (pageIndexes.has(page.index)) throw new Error(`Duplicate world region page index: ${page.index}`);
  pageIndexes.add(page.index);
  if (!fitsGrid(page.bounds, ctx.gridSize) || (ctx.bounds && !contains(ctx.bounds, page.bounds))) throw new Error(`Region page ${page.index} is outside the world bounds`);
  if (page.blockCount > volume(page.bounds)) throw new Error(`Region page ${page.index} blockCount exceeds its bounds`);
  checkPartRef(page.data, ctx);
}

function validateManifest(manifest: VoxelWorldManifest, opts: VoxelWorldParseOptions) {
  const worldVolume = manifest.gridSize ** 3;
  if (manifest.exactBlockCount > worldVolume) throw new Error("exactBlockCount exceeds the world volume");
  if (manifest.bounds && !fitsGrid(manifest.bounds, manifest.gridSize)) throw new Error("bounds exceeds the grid");
  if (manifest.exactBlockCount === 0 && manifest.bounds) throw new Error("Empty worlds must not declare bounds");
  if (manifest.exactBlockCount > 0 && !manifest.bounds) throw new Error("Non-empty worlds require bounds");
  if (manifest.bounds && manifest.exactBlockCount > volume(manifest.bounds)) throw new Error("exactBlockCount exceeds the world bounds");

  const regions = manifest.regions ?? [];
  const pages = manifest.regionPages ?? [];
  if (regions.length > 0 && pages.length > 0) throw new Error("World manifest cannot mix inline regions and region pages");
  if (manifest.exactBlockCount > 0 && regions.length === 0 && pages.length === 0) throw new Error("Non-empty worlds require regions or region pages");

  const ctx = newContext(manifest.gridSize, manifest.bounds, opts);
  for (const region of regions) checkRegion(region, ctx);
  const pageIndexes = new Set<number>();
  for (const page of pages) checkPageRef(page, ctx, pageIndexes);
  const items = regions.length > 0 ? regions : pages;
  if (checkedSum(items, worldVolume, regions.length > 0 ? "regions.blockCount" : "regionPages.blockCount") !== manifest.exactBlockCount) {
    throw new Error("World region counts do not match exactBlockCount");
  }
}

function validatePage(page: VoxelWorldRegionPage, opts: VoxelWorldRegionPageParseOptions) {
  const gridSize = positiveCountSchema.max(VOXEL_WORLD_MAX_GRID_SIZE).parse(opts.gridSize ?? VOXEL_WORLD_MAX_GRID_SIZE);
  if (!fitsGrid(page.bounds, gridSize) || (opts.worldBounds && !contains(opts.worldBounds, page.bounds))) throw new Error(`Region page ${page.index} is outside the world bounds`);
  if (opts.pageRef) {
    const ref = opts.pageRef;
    if (ref.index !== page.index || ref.regionCount !== page.regionCount || ref.blockCount !== page.blockCount || !sameBounds(ref.bounds, page.bounds)) {
      throw new Error("Region page does not match its manifest reference");
    }
  }
  if (page.blockCount > volume(page.bounds)) throw new Error("Region page blockCount exceeds its bounds");
  if (page.regionCount !== page.regions.length) throw new Error("Region page regionCount does not match regions");
  const ctx = newContext(gridSize, page.bounds, opts);
  for (const region of page.regions) checkRegion(region, ctx);
  if (checkedSum(page.regions, volume(page.bounds), "regions.blockCount") !== page.blockCount) throw new Error("Region page counts do not match blockCount");
}

function parseValue<T>(parsed: z.SafeParseReturnType<unknown, T>, validate: (value: T) => void, fallback: string) {
  if (!parsed.success) return { ok: false as const, error: zodError(parsed.error) };
  try {
    validate(parsed.data);
    return { ok: true as const, value: parsed.data };
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false as const, error: zodError(error) };
    return { ok: false as const, error: error instanceof Error ? error.message : fallback };
  }
}

export function parseVoxelWorldManifest(input: unknown, opts: VoxelWorldParseOptions = {}): VoxelWorldManifestParseResult {
  return parseValue(manifestSchema.safeParse(input), (manifest) => validateManifest(manifest, opts), "Invalid voxel world manifest");
}

export function parseVoxelWorldRegionPage(input: unknown, opts: VoxelWorldRegionPageParseOptions = {}): VoxelWorldRegionPageParseResult {
  return parseValue(regionPageSchema.safeParse(input), (page) => validatePage(page, opts), "Invalid voxel world region page");
}

function cloneBounds(bounds: VoxelWorldBounds): VoxelWorldBounds {
  return { origin: { ...bounds.origin }, size: { ...bounds.size } };
}

function toOpaquePartRef(ref: VoxelWorldPartRef): VoxelWorldPartRef {
  return ref.kind === "stored" ? { kind: "opaque", key: ref.key, encoding: ref.encoding, byteSize: ref.byteSize, sha256: ref.sha256 } : { ...ref };
}

function toOpaqueRegion(region: VoxelWorldRegion): VoxelWorldRegion {
  return region.kind === "mixed"
    ? { ...region, origin: { ...region.origin }, size: { ...region.size }, data: toOpaquePartRef(region.data) }
    : { ...region, origin: { ...region.origin }, size: { ...region.size } };
}

export function toOpaqueVoxelWorldManifest(manifest: VoxelWorldManifest): VoxelWorldManifest {
  return {
    ...manifest,
    bounds: manifest.bounds ? cloneBounds(manifest.bounds) : null,
    source: { ...manifest.source },
    regions: manifest.regions?.map(toOpaqueRegion),
    regionPages: manifest.regionPages?.map((page) => ({ ...page, bounds: cloneBounds(page.bounds), data: toOpaquePartRef(page.data) })),
  };
}

export function toOpaqueVoxelWorldRegionPage(page: VoxelWorldRegionPage): VoxelWorldRegionPage {
  return { ...page, bounds: cloneBounds(page.bounds), regions: page.regions.map(toOpaqueRegion) };
}

export function voxelWorldPartUrl(delivery: VoxelWorldDelivery, key: string): string {
  const partBaseUrl = delivery.partBaseUrl?.trim();
  if (!partBaseUrl) throw new Error("Voxel world part base URL is missing");
  return `${partBaseUrl}${partBaseUrl.includes("?") ? "&" : "?"}part=${encodeURIComponent(keySchema.parse(key))}`;
}
