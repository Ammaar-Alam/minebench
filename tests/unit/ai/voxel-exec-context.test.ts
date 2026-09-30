import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { runVoxelExec } from "../../../lib/ai/tools/voxelExec";
import { getPalette } from "../../../lib/blocks/palettes";
import { canonicalBuildJsonChunks } from "../../../lib/voxel/canonicalArtifact";
import { validateOwnedVoxelBuild } from "../../../lib/voxel/validate";
import { unpackVoxelBlocks } from "../../../lib/voxel/packedBlocks";

const originalCreateContext = vm.createContext;
const originalTimeout = process.env.MINEBENCH_TOOL_TIMEOUT_MS;
const originalOutputDir = process.env.MINEBENCH_TOOL_OUTPUT_DIR;
delete process.env.MINEBENCH_TOOL_OUTPUT_DIR;
delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;

try {
  let usedFastContext = false;
  vm.createContext = function (contextObject, options) {
    usedFastContext = Boolean(vm.constants?.DONT_CONTEXTIFY && contextObject === vm.constants.DONT_CONTEXTIFY);
    return originalCreateContext(contextObject, options);
  };
  runVoxelExec({ code: "", gridSize: 256, palette: "simple" });
  assert.equal(usedFastContext, Boolean(vm.constants?.DONT_CONTEXTIFY), "use the native fast context when the runtime supports it");
  vm.createContext = originalCreateContext;

  for (const code of [
    'var marker=7; block(globalThis.marker ?? 0,0,0,"stone");',
    'var Math; block(Math.floor(7.9),0,0,"stone");',
    'const Math={floor:()=>7}; block(Math.floor(),0,0,"stone");',
    'globalThis.Math={floor:()=>7}; block(Math.floor(),0,0,"stone");',
  ]) {
    assert.equal(runVoxelExec({ code, gridSize: 256, palette: "simple" }).build.blocks[0]?.x, 7);
  }
  assert.equal(runVoxelExec({ code: 'block(typeof marker === "undefined" ? 1 : 0,0,0,"stone");', gridSize: 256, palette: "simple" }).build.blocks[0]?.x, 1, "every run has a fresh global scope");

  for (const gridSize of [32, 64, 256, 512, 2048, 8192] as const) {
    for (const packedOutput of [false, true]) {
      const code = 'var x=3; box(0,0,0,2,1,2,"stone"); line(0,0,0,2,0,2,"glass"); block(x,2,3,rng()<0.5?"gold_block":"oak_log"); block(0,0,0,"water");';
      const hashes = [false, true].map((legacyContext) => {
        vm.createContext = legacyContext
          ? function (contextObject, options) {
              return originalCreateContext(typeof contextObject === "symbol" ? Object.create(null) : contextObject, options);
            }
          : originalCreateContext;
        const result = runVoxelExec({ code, gridSize, palette: "simple", seed: 123, packedOutput });
        const validated = validateOwnedVoxelBuild(result.build, { gridSize, palette: getPalette("simple"), maxBlocks: gridSize ** 3, output: "packed" });
        assert.ok(validated.ok);
        const hash = createHash("sha256");
        for (const chunk of canonicalBuildJsonChunks(validated.value.build)) hash.update(chunk);
        return hash.digest("hex");
      });
      assert.equal(hashes[0], hashes[1], `complete geometry must match the legacy context at grid ${gridSize}, packed=${packedOutput}`);
      vm.createContext = originalCreateContext;
    }
    assert.throws(() => runVoxelExec({ code: 'eval("1")', gridSize, palette: "simple" }), /Code generation from strings disallowed/);
    assert.throws(() => runVoxelExec({ code: 'new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))', gridSize, palette: "simple" }), /Wasm code generation disallowed/);
    const scope = runVoxelExec({ code: 'block(typeof process === "undefined" && typeof require === "undefined" && typeof Buffer === "undefined" ? 1 : 0,0,0,"stone");', gridSize, palette: "simple" });
    assert.equal((scope.build.packed ? unpackVoxelBlocks(scope.build.packed) : scope.build.blocks)[0]?.x, 1);
  }
  process.env.MINEBENCH_TOOL_TIMEOUT_MS = "250";
  assert.throws(() => runVoxelExec({ code: "while(true){}", gridSize: 256, palette: "simple" }), /Script execution timed out after 250ms/);
  console.log("voxel exec native context checks passed");
} finally {
  vm.createContext = originalCreateContext;
  if (originalTimeout === undefined) delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
  else process.env.MINEBENCH_TOOL_TIMEOUT_MS = originalTimeout;
  if (originalOutputDir === undefined) delete process.env.MINEBENCH_TOOL_OUTPUT_DIR;
  else process.env.MINEBENCH_TOOL_OUTPUT_DIR = originalOutputDir;
}
