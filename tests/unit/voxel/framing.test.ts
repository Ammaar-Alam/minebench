import assert from "node:assert/strict";
import * as THREE from "three";
import {
  fitDistanceToRotatingBounds,
  minimumOrbitDistance,
  retargetDistanceForAspect,
  worldCameraClipping,
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

assert.equal(minimumOrbitDistance(80), 9.6, "legacy orbit keeps its proportional zoom limit");
assert.equal(minimumOrbitDistance(1), 0.5, "small legacy builds keep their minimum distance");

const manhattanElevation = (0.38 + (189 / 7267) * 0.22) * 1.1;
const manhattanFraming: RotatingBoundsFraming = {
  width: 2436,
  height: 189,
  depth: 7267,
  verticalFovDegrees: 45,
  cameraDirectionY: manhattanElevation / Math.hypot(1, manhattanElevation, 1),
};
for (const aspect of [liveAspect, verticalAspect]) {
  const manhattanFit = fitDistanceToRotatingBounds(manhattanFraming, aspect);
  assert.ok(minimumOrbitDistance(manhattanFit) > 800, "the legacy limit prevents approaching Manhattan's blocks");
  assert.equal(
    minimumOrbitDistance(manhattanFit, true),
    0.5,
    "world orbit can approach individual blocks regardless of whole-world framing",
  );
}

const manhattanBox = new THREE.Box3(
  new THREE.Vector3(-1218, 0, -3633.5),
  new THREE.Vector3(1218, 189, 3633.5),
);
const manhattanBounds = {
  box: manhattanBox,
  center: manhattanBox.getCenter(new THREE.Vector3()),
  radius: manhattanBox.getSize(new THREE.Vector3()).length() / 2,
};
const insideCity = new THREE.Vector3(0, 13.82, 0);
const insideClipping = worldCameraClipping(insideCity, manhattanBounds);
assert.equal(insideClipping.near, 0.05, "the near plane stays below block scale inside the city");
const camera = new THREE.PerspectiveCamera(45, liveAspect, insideClipping.near, insideClipping.far);
camera.position.copy(insideCity);
camera.updateMatrixWorld(true);
const closePoint = insideCity.clone().add(new THREE.Vector3(0, 0, -0.5)).project(camera);
assert.ok(closePoint.z >= -1 && closePoint.z <= 1, "a point half a block away remains inside the camera's clipping range");

const distantCamera = new THREE.Vector3(0, 5000, 10000);
assert.ok(worldCameraClipping(distantCamera, manhattanBounds).near > 1, "distant cameras retain useful depth precision");
for (const position of [insideCity, distantCamera]) {
  const { far } = worldCameraClipping(position, manhattanBounds);
  for (const x of [manhattanBox.min.x, manhattanBox.max.x]) {
    for (const y of [manhattanBox.min.y, manhattanBox.max.y]) {
      for (const z of [manhattanBox.min.z, manhattanBox.max.z]) {
        assert.ok(position.distanceTo(new THREE.Vector3(x, y, z)) < far, "the far plane encloses every world corner");
      }
    }
  }
}

const portraitDistance = retargetDistanceForAspect({
  ...manhattanFraming,
  distance: fitDistanceToRotatingBounds(manhattanFraming, liveAspect) * 1.1,
  sourceAspect: liveAspect,
  targetAspect: verticalAspect,
});
camera.position.copy(manhattanBounds.center).addScaledVector(new THREE.Vector3(1, manhattanElevation, 1).normalize(), portraitDistance);
camera.lookAt(manhattanBounds.center);
camera.aspect = verticalAspect;
Object.assign(camera, worldCameraClipping(camera.position, manhattanBounds));
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
const portraitDepth = manhattanBounds.center.clone().project(camera).z;
assert.ok(portraitDepth >= -1 && portraitDepth <= 1, "portrait capture retains the city after moving the camera farther back");

const thinWorldBox = new THREE.Box3(new THREE.Vector3(-1, 0, -2000), new THREE.Vector3(1, 10, 2000));
const thinWorldBounds = {
  box: thinWorldBox,
  center: thinWorldBox.getCenter(new THREE.Vector3()),
  radius: thinWorldBox.getSize(new THREE.Vector3()).length() / 2,
};
const rotatedCamera = new THREE.PerspectiveCamera(45, liveAspect);
rotatedCamera.position.set(1800, 5, 1.5);
const nearbyRotatedPoint = new THREE.Vector3(1800, 5, 1);
rotatedCamera.lookAt(nearbyRotatedPoint);
const localCameraPosition = rotatedCamera.position.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -Math.PI / 2);
Object.assign(rotatedCamera, worldCameraClipping(localCameraPosition, thinWorldBounds));
rotatedCamera.updateProjectionMatrix();
rotatedCamera.updateMatrixWorld(true);
const rotatedDepth = nearbyRotatedPoint.clone().project(rotatedCamera).z;
assert.ok(rotatedDepth >= -1 && rotatedDepth <= 1, "a quarter-turn world retains blocks half a unit from the camera");

console.log("voxel framing checks passed");
