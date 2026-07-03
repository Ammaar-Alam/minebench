export class CustomBuildLeaseLostError extends Error {
  constructor(message = "Custom build job lease is no longer owned by this worker.") {
    super(message);
    this.name = "CustomBuildLeaseLostError";
  }
}

export function isCustomBuildLeaseLostError(error: unknown): error is CustomBuildLeaseLostError {
  return error instanceof CustomBuildLeaseLostError;
}

export function throwIfCustomBuildLeaseLost(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (isCustomBuildLeaseLostError(signal.reason)) {
    throw signal.reason;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new CustomBuildLeaseLostError();
}
