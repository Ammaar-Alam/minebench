export class CustomBuildLeaseLostError extends Error {
  constructor(message = "Custom build job lease is no longer owned by this worker.") {
    super(message);
    this.name = "CustomBuildLeaseLostError";
  }
}

export class CustomBuildWorkerShutdownError extends Error {
  constructor(message = "Custom build worker is shutting down.") {
    super(message);
    this.name = "CustomBuildWorkerShutdownError";
  }
}

export function isCustomBuildLeaseLostError(error: unknown): error is CustomBuildLeaseLostError {
  return error instanceof CustomBuildLeaseLostError;
}

export function isCustomBuildWorkerShutdownError(
  error: unknown,
): error is CustomBuildWorkerShutdownError {
  return error instanceof CustomBuildWorkerShutdownError;
}

export function throwIfCustomBuildLeaseLost(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (isCustomBuildWorkerShutdownError(signal.reason)) {
    throw signal.reason;
  }
  if (isCustomBuildLeaseLostError(signal.reason)) {
    throw signal.reason;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new CustomBuildLeaseLostError();
}
