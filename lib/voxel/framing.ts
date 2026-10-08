import type * as THREE from "three";

const MIN_FIT_DISTANCE = 0.001;

export type RotatingBoundsFraming = {
  width: number;
  height: number;
  depth: number;
  verticalFovDegrees: number;
  cameraDirectionY: number;
};

export function minimumOrbitDistance(fitDistance: number, isWorld = false): number {
  return isWorld ? 0.5 : Math.max(0.5, fitDistance * 0.12);
}

export function worldCameraClipping(
  cameraPosition: THREE.Vector3,
  bounds: { box: THREE.Box3; center: THREE.Vector3; radius: number },
): { near: number; far: number } {
  return {
    near: Math.max(0.05, bounds.box.distanceToPoint(cameraPosition) / 250),
    far: Math.max(1000, cameraPosition.distanceTo(bounds.center) + bounds.radius + 64),
  };
}

export function fitDistanceToRotatingBounds(
  framing: RotatingBoundsFraming,
  aspect: number,
): number {
  const radius = Math.hypot(framing.width, framing.depth) / 2;
  const halfHeight = framing.height / 2;
  const verticalFov = (framing.verticalFovDegrees * Math.PI) / 180;
  const cotVerticalFov = 1 / Math.tan(verticalFov / 2);
  const cotHorizontalFov = cotVerticalFov / Math.max(MIN_FIT_DISTANCE, aspect);
  const sinElevation = Math.min(1, Math.abs(framing.cameraDirectionY));
  const cosElevation = Math.sqrt(Math.max(0, 1 - sinElevation * sinElevation));

  // A Y-axis spin sweeps the build through this cylinder
  const horizontalFit =
    radius * Math.hypot(cosElevation, cotHorizontalFov) + halfHeight * sinElevation;
  const upperVerticalFit =
    radius * Math.abs(cosElevation - sinElevation * cotVerticalFov) +
    halfHeight * Math.abs(sinElevation + cosElevation * cotVerticalFov);
  const lowerVerticalFit =
    radius * Math.abs(cosElevation + sinElevation * cotVerticalFov) +
    halfHeight * Math.abs(sinElevation - cosElevation * cotVerticalFov);

  return Math.max(MIN_FIT_DISTANCE, horizontalFit, upperVerticalFit, lowerVerticalFit);
}

type Vec3 = { x: number; y: number; z: number };

// closest still shot that keeps every point in frame, centered on where they land in the image
// points are relative to the look target, direction is the unit vector from target to camera
// returns the camera distance and how far to move the look target
export function fitStillView(
  points: readonly Vec3[],
  direction: Vec3,
  verticalFovDegrees: number,
  aspect: number,
): { distance: number; shift: Vec3 } {
  const tanVertical = Math.tan((verticalFovDegrees * Math.PI) / 360);
  const tanHorizontal = tanVertical * Math.max(MIN_FIT_DISTANCE, aspect);
  // camera right and up under a world-up lookAt; a straight-down view falls back to +x
  const rightLength = Math.hypot(direction.x, direction.z);
  const right = rightLength > 1e-9 ? { x: direction.z / rightLength, y: 0, z: -direction.x / rightLength } : { x: 1, y: 0, z: 0 };
  const up = {
    x: right.y * direction.z - right.z * direction.y,
    y: right.z * direction.x - right.x * direction.z,
    z: right.x * direction.y - right.y * direction.x,
  };
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

  let shift: Vec3 = { x: 0, y: 0, z: 0 };
  let distance = MIN_FIT_DISTANCE;
  // fit, move the look target to the middle of the projected extent, and refit; perspective makes one pass approximate
  for (let pass = 0; pass < 3; pass += 1) {
    const local = points.map((p) => ({ x: p.x - shift.x, y: p.y - shift.y, z: p.z - shift.z }));
    distance = MIN_FIT_DISTANCE;
    for (const p of local) {
      const toward = dot(p, direction);
      distance = Math.max(distance, Math.abs(dot(p, right)) / tanHorizontal + toward, Math.abs(dot(p, up)) / tanVertical + toward);
    }
    if (pass === 2) break;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of local) {
      const depth = distance - dot(p, direction);
      const x = dot(p, right) / (depth * tanHorizontal);
      const y = dot(p, up) / (depth * tanVertical);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const dx = ((minX + maxX) / 2) * distance * tanHorizontal;
    const dy = ((minY + maxY) / 2) * distance * tanVertical;
    shift = {
      x: shift.x + right.x * dx + up.x * dy,
      y: shift.y + right.y * dx + up.y * dy,
      z: shift.z + right.z * dx + up.z * dy,
    };
  }
  return { distance, shift };
}

export function retargetDistanceForAspect(
  framing: RotatingBoundsFraming & {
    distance: number;
    sourceAspect: number;
    targetAspect: number;
  },
): number {
  if (framing.sourceAspect === framing.targetAspect) return framing.distance;

  const sourceFit = fitDistanceToRotatingBounds(framing, framing.sourceAspect);
  const targetFit = fitDistanceToRotatingBounds(framing, framing.targetAspect);
  return framing.distance * (targetFit / sourceFit);
}
