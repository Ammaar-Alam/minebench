import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { getPalette } from "../../lib/blocks/palettes";
import {
  buildSpongeSchematic,
  buildVoxelExportGeometry,
  buildVoxelGlb,
  buildVoxelStl,
} from "../../lib/voxel/export";
import type { VoxelBuild } from "../../lib/voxel/types";

const OUT_DIR = join(tmpdir(), "minebench-export-verify");
const EXPORT_PERFORMANCE_BUDGET_MS = 2000;
const enforceExportPerformanceBudget = process.env.MINEBENCH_ENFORCE_EXPORT_PERF_BUDGET === "1";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeFixtureBuild(): VoxelBuild {
  const blocks: VoxelBuild["blocks"] = [];
  const put = (x: number, y: number, z: number, type: string) => blocks.push({ x, y, z, type });

  for (let x = 0; x < 14; x += 1) {
    for (let z = 0; z < 14; z += 1) put(x, 0, z, "stone");
  }
  for (let y = 1; y <= 8; y += 1) {
    put(0, y, 0, "oak_log");
    put(13, y, 0, "oak_log");
    put(0, y, 13, "oak_log");
    put(13, y, 13, "oak_log");
  }
  for (let x = 1; x < 13; x += 1) {
    put(x, 5, 0, "glass");
    put(x, 5, 13, "glass");
    put(x, 9, 6, "glowstone");
  }
  for (let z = 1; z < 13; z += 1) {
    put(0, 5, z, "glass");
    put(13, 5, z, "glass");
  }
  for (let x = 4; x < 10; x += 1) {
    for (let z = 4; z < 10; z += 1) put(x, 1, z, "water");
  }
  for (let x = 2; x < 12; x += 1) {
    for (let z = 2; z < 12; z += 1) put(x, 10, z, "oak_leaves");
  }

  return { version: "1.0", blocks };
}

function makeHundredThousandBlockBuild(): VoxelBuild {
  const blocks: VoxelBuild["blocks"] = [];
  for (let x = 0; x < 50; x += 1) {
    for (let y = 0; y < 40; y += 1) {
      for (let z = 0; z < 50; z += 1) {
        blocks.push({ x, y, z, type: y === 39 ? "grass_block" : "stone" });
      }
    }
  }
  assert(blocks.length === 100_000, "performance fixture should contain 100000 blocks");
  return { version: "1.0", blocks };
}

function parseGlbJson(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(view.getUint32(0, true) === 0x46546c67, "GLB magic mismatch");
  assert(view.getUint32(4, true) === 2, "GLB version mismatch");
  assert(view.getUint32(8, true) === bytes.byteLength, "GLB length mismatch");
  const jsonLength = view.getUint32(12, true);
  assert(view.getUint32(16, true) === 0x4e4f534a, "GLB JSON chunk missing");
  const jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim();
  return JSON.parse(jsonText) as Record<string, unknown>;
}

function validateGlb(bytes: Uint8Array) {
  const gltf = parseGlbJson(bytes);
  const materials = gltf.materials as Array<{ extras?: Record<string, unknown> }> | undefined;
  assert(Array.isArray(materials) && materials.length >= 4, "GLB should include material buckets");
  const blockIds = materials.map((material) => material.extras?.minebenchBlockId);
  assert(blockIds.includes("stone"), "GLB material metadata missing stone");
  assert(blockIds.includes("glass"), "GLB material metadata missing glass");
  assert(blockIds.includes("water"), "GLB material metadata missing water");
}

function validateStl(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  assert(triangleCount > 0, "STL triangle count should be positive");
  assert(bytes.byteLength === 84 + triangleCount * 50, "STL byte length does not match triangle count");
}

function validateSchem(bytes: Uint8Array, opts: { expectLeaves?: boolean } = {}) {
  assert(bytes[0] === 0x1f && bytes[1] === 0x8b, "SCHEM should be gzip compressed");
  const raw = gunzipSync(bytes);
  const text = new TextDecoder().decode(raw);
  assert(text.includes("Schematic"), "SCHEM root missing Schematic");
  assert(text.includes("Palette"), "SCHEM missing palette");
  assert(text.includes("minecraft:stone"), "SCHEM missing stone block state");
  if (opts.expectLeaves) {
    assert(text.includes("minecraft:oak_leaves[persistent=true]"), "SCHEM missing persistent leaves");
  }
}

async function main() {
  const palette = getPalette("advanced");
  const fixture = makeFixtureBuild();
  const geometry = buildVoxelExportGeometry(fixture, palette);
  const glb = buildVoxelGlb(geometry);
  const stl = buildVoxelStl(geometry);
  const schemRaw = buildSpongeSchematic(fixture, palette);
  const schem = gzipSync(schemRaw.bytes);

  validateGlb(glb);
  validateStl(stl);
  validateSchem(schem, { expectLeaves: true });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/fixture.glb`, glb);
  await writeFile(`${OUT_DIR}/fixture.stl`, stl);
  await writeFile(`${OUT_DIR}/fixture.schem`, schem);

  const largeBuild = makeHundredThousandBlockBuild();
  const t0 = performance.now();
  const largeGeometry = buildVoxelExportGeometry(largeBuild, palette);
  const t1 = performance.now();
  const largeGlb = buildVoxelGlb(largeGeometry);
  const t2 = performance.now();
  const largeStl = buildVoxelStl(largeGeometry);
  const t3 = performance.now();
  const largeSchem = gzipSync(buildSpongeSchematic(largeBuild, palette).bytes);
  const t4 = performance.now();
  const totalMs = t4 - t0;

  if (enforceExportPerformanceBudget && totalMs >= EXPORT_PERFORMANCE_BUDGET_MS) {
    throw new Error(`100k export path took ${Math.round(totalMs)}ms`);
  }
  assert(largeGlb.byteLength > 1000, "large GLB should not be empty");
  assert(largeStl.byteLength > 1000, "large STL should not be empty");
  validateSchem(largeSchem);

  console.log(
    JSON.stringify(
      {
        fixture: {
          blocks: fixture.blocks.length,
          glbBytes: glb.byteLength,
          stlBytes: stl.byteLength,
          schemBytes: schem.byteLength,
          triangles: geometry.triangleCount,
          materials: geometry.materialCount,
          artifacts: OUT_DIR,
        },
        large: {
          blocks: largeBuild.blocks.length,
          geometryMs: Math.round(t1 - t0),
          glbMs: Math.round(t2 - t1),
          stlMs: Math.round(t3 - t2),
          schemMs: Math.round(t4 - t3),
          totalMs: Math.round(totalMs),
          perfBudgetMs: enforceExportPerformanceBudget ? EXPORT_PERFORMANCE_BUDGET_MS : null,
          glbBytes: largeGlb.byteLength,
          stlBytes: largeStl.byteLength,
          schemBytes: largeSchem.byteLength,
          triangles: largeGeometry.triangleCount,
          materials: largeGeometry.materialCount,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
