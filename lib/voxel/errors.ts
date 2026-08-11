export const VOXEL_VIEWER_WEBGL_ERROR = "__minebench_webgl_unavailable__";

export function isVoxelViewerWebGLUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === VOXEL_VIEWER_WEBGL_ERROR;
}
