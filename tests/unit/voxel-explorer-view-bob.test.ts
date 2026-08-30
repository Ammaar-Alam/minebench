import assert from "node:assert/strict";
import {
  setExplorerViewBob,
  type ExplorerViewBobTransform,
} from "@/lib/voxel/explorerViewBob";

const bob: ExplorerViewBobTransform = { x: 0, y: 0, roll: 0, pitch: 0 };

setExplorerViewBob(bob, 0, 0.1);
assert.equal(bob.x, 0);
assert.equal(bob.y, -0.1);
assert.equal(bob.roll, 0);
assert.ok(bob.pitch > 0);

setExplorerViewBob(bob, 0.5, 0.1);
assert.ok(Math.abs(bob.x - 0.05) < 1e-12);
assert.ok(Math.abs(bob.y) < 1e-12);
assert.ok(bob.roll > 0);

setExplorerViewBob(bob, 1, 0);
assert.equal(Math.hypot(bob.x, bob.y, bob.roll, bob.pitch), 0);
