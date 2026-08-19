import assert from "node:assert/strict";
import {
  fitDistanceToRotatingBounds,
  retargetDistanceForAspect,
  type RotatingBoundsFraming,
} from "../../../lib/voxel/framing";

const framing: RotatingBoundsFraming = {
  width: 40,
  height: 8,
  depth: 40,
  verticalFovDegrees: 45,
  cameraDirectionY: 0.313,
};

const liveAspect = 1.6;
const verticalAspect = 351 / 550;
const liveFit = fitDistanceToRotatingBounds(framing, liveAspect);
const verticalFit = fitDistanceToRotatingBounds(framing, verticalAspect);

assert.ok(verticalFit > liveFit, "a narrower frame should move a wide build farther back");

const liveDistance = liveFit * 0.82;
assert.equal(
  retargetDistanceForAspect({
    ...framing,
    distance: liveDistance,
    sourceAspect: liveAspect,
    targetAspect: liveAspect,
  }),
  liveDistance,
  "matching aspects should preserve the camera exactly",
);

const verticalDistance = retargetDistanceForAspect({
  ...framing,
  distance: liveDistance,
  sourceAspect: liveAspect,
  targetAspect: verticalAspect,
});
assert.ok(
  Math.abs(verticalDistance / verticalFit - liveDistance / liveFit) < 1e-12,
  "aspect retargeting should preserve the user's zoom ratio",
);

const sphereRadius = Math.hypot(framing.width / 2, framing.height / 2, framing.depth / 2);
const sphereFit = sphereRadius / Math.sin((framing.verticalFovDegrees * Math.PI) / 360);
assert.ok(liveFit < sphereFit, "a rotating cylinder should frame flat builds more tightly than a sphere");

console.log("voxel framing checks passed");
