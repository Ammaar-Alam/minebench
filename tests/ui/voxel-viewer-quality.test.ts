import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync("components/voxel/VoxelViewer.tsx", "utf8");
const start = source.match(/const onStart = \(\) => \{([^}]+)\}/)![1];
const end = source.match(/const onEnd = \(\) => \{([^}]+)\}/)![1];
const frame = source.match(/const pixelRatio = fullPixelRatio[^\n]+\n\s*if \(renderer.getPixelRatio\(\)[^\n]+/)![0];
let pixelRatio = 2, resizes = 0, requests = 0;
const state = {
  fullPixelRatio: 2,
  controlsChanged: false,
  vg: { world: true },
  isVoxelWorldScene: (group: { world: boolean }) => group.world,
  userInteractingRef: { current: false },
  requestRenderRef: { current: () => { requests += 1; } },
  renderer: {
    getPixelRatio: () => pixelRatio,
    setPixelRatio: (ratio: number) => { pixelRatio = ratio; resizes += 1; },
  },
};
const context = createContext(state);
const render = () => runInContext(`{ ${frame} }`, context);
render();
runInContext(start, context);
render();
assert.equal(pixelRatio, 2, "pressing without moving keeps full resolution");
state.controlsChanged = true;
render();
assert.equal(pixelRatio, 1.8, "dragging lowers render scale by only ten percent");
render();
assert.equal(resizes, 1, "continued dragging does not repeatedly resize the drawing buffer");
runInContext(end, context);
assert.equal(requests, 1, "release schedules a full-resolution frame even without auto rotation");
render();
assert.equal(pixelRatio, 2, "a released flick restores full resolution while damping continues");
runInContext(start, context);
runInContext(end, context);
render();
assert.equal(resizes, 2, "a wheel gesture that starts and ends before rendering keeps full resolution");
state.vg.world = false;
runInContext(start, context);
render();
assert.equal(pixelRatio, 2, "ordinary builds retain their resolution");
console.log("voxel viewer quality checks passed");
