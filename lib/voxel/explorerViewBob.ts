const DEG_TO_RAD = Math.PI / 180;

export type ExplorerViewBobTransform = {
  x: number;
  y: number;
  roll: number;
  pitch: number;
};

export function setExplorerViewBob(
  target: ExplorerViewBobTransform,
  walkDistance: number,
  amount: number,
) {
  const phase = walkDistance * Math.PI;
  const sway = Math.sin(phase);
  target.x = sway * amount * 0.5;
  target.y = -Math.abs(Math.cos(phase) * amount);
  target.roll = sway * amount * 3 * DEG_TO_RAD;
  target.pitch = Math.abs(Math.cos(phase - 0.2) * amount) * 5 * DEG_TO_RAD;
}
