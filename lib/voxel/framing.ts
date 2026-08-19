const MIN_FIT_DISTANCE = 0.001;

export type RotatingBoundsFraming = {
  width: number;
  height: number;
  depth: number;
  verticalFovDegrees: number;
  cameraDirectionY: number;
};

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
