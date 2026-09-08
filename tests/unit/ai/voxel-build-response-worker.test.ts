import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import type { VoxelBuildResponseOptions } from "../../../lib/ai/processVoxelBuildResponse";
import { processVoxelBuildResponseInWorker } from "../../../scripts/process-voxel-build-response";

const options: VoxelBuildResponseOptions = {
  gridSize: 256, palette: "simple", enableTools: true, buildOutput: "packed",
};
const response = (code: string, gridSize = options.gridSize) => JSON.stringify({
  tool: "voxel.exec", input: { code, gridSize, palette: options.palette, seed: 1 },
});
const smallResponse = response('box(0, 0, 0, 63, 31, 63, "stone");');
const densePoints = response('for(let x=0;x<256;x++) for(let y=0;y<256;y++) for(let z=0;z<256;z++) block(x,y,z,"stone");');
const bufferedPoints = response('const points=[]; for(let x=0;x<256;x++) for(let y=0;y<64;y++) for(let z=0;z<256;z++) points.push({x,y,z}); for(const point of points) block(point.x,point.y,point.z,"stone");');

async function heapFailure() {
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 10);
  try {
    await assert.rejects(processVoxelBuildResponseInWorker(bufferedPoints, options), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "heap_limit_exceeded");
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_WORKER_OUT_OF_MEMORY");
      return true;
    });
  } finally {
    clearInterval(heartbeat);
  }
  assert.ok(heartbeats > 2, "parent remains responsive through isolated heap exhaustion");
  const recovered = await processVoxelBuildResponseInWorker(smallResponse, options);
  assert.ok(recovered.ok, "a subsequent job succeeds in the same parent");
  assert.equal(recovered.blockCount, 64 * 32 * 64);
  console.log("voxel response worker heap containment checks passed");
}

async function main() {
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 10);
  const denseSignal = AbortSignal.timeout(10_000);
  const dense = await processVoxelBuildResponseInWorker(
    response('box(0, 0, 0, 255, 63, 255, "stone");'), options, denseSignal,
  ).finally(() => clearInterval(heartbeat));
  assert.ok(dense.ok);
  assert.equal(dense.blockCount, 256 * 64 * 256);
  assert.deepEqual(dense.build.blocks, []);
  const packed = dense.build.packed!;
  assert.ok(packed.positions instanceof Int16Array);
  assert.ok(packed.typeIds instanceof Uint16Array);
  assert.equal(packed.count, dense.blockCount);
  assert.equal(packed.positions.byteLength + packed.typeIds.byteLength, packed.count * 8);
  assert.deepEqual(packed.typeNames, ["stone"]);
  assert.deepEqual(Array.from(packed.positions.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(packed.positions.slice(-3)), [255, 63, 255]);
  assert.ok(heartbeats > 2, "processing leaves the parent event loop available");
  assert.equal(getEventListeners(denseSignal, "abort").length, 0, "completed jobs release abort listeners");

  const world = await processVoxelBuildResponseInWorker(
    response('box(0, 0, 0, 8191, 8191, 8191, "stone");', 8192),
    { ...options, gridSize: 8192 },
  );
  assert.ok(world.ok);
  assert.equal(world.blockCount, 8192 ** 3);
  assert.equal(world.build.blocks.length, 0);
  assert.equal(world.build.packed?.count ?? 0, 0);
  assert.equal(world.build.packedBoxes?.count, 1, "whole worlds retain compact primitives across the thread boundary");

  const overCapacity = await processVoxelBuildResponseInWorker(
    response('box(0, 0, 0, 511, 511, 511, "stone");', 512),
    { ...options, gridSize: 512 },
  );
  assert.deepEqual(overCapacity, { ok: false, error: "processing_capacity_exceeded" });

  const invalid = await processVoxelBuildResponseInWorker("not a build", options);
  assert.equal(invalid.ok, false, "validation failures remain ordinary results");
  await assert.rejects(processVoxelBuildResponseInWorker(
    response('throw new Error("ordinary generated-program error");'), options,
  ), /ordinary generated-program error/);

  const previousTimeout = process.env.MINEBENCH_TOOL_TIMEOUT_MS;
  process.env.MINEBENCH_TOOL_TIMEOUT_MS = "250";
  try {
    await assert.rejects(
      processVoxelBuildResponseInWorker(response("while (true) {}"), options),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT",
    );
  } finally {
    if (previousTimeout === undefined) delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    else process.env.MINEBENCH_TOOL_TIMEOUT_MS = previousTimeout;
  }

  const reason = new Error("generation lease lost");
  const preAborted = new AbortController();
  preAborted.abort(reason);
  await assert.rejects(processVoxelBuildResponseInWorker(smallResponse, options, preAborted.signal), (error) => error === reason);
  const controller = new AbortController();
  const pending = processVoxelBuildResponseInWorker(densePoints, options, controller.signal);
  const abort = setTimeout(() => controller.abort(reason), 200);
  try {
    await assert.rejects(pending, (error) => error === reason);
  } finally {
    clearTimeout(abort);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  const child = spawnSync(process.execPath, [
    "--max-old-space-size=64", "--import", "tsx", fileURLToPath(import.meta.url), "--heap-child",
  ], { env: process.env, encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, `isolated heap failure did not recover\n${child.stdout}\n${child.stderr}`);
  console.log(child.stdout.trim());
  console.log("voxel response worker runtime checks passed");
}

(process.argv.includes("--heap-child") ? heapFailure() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
