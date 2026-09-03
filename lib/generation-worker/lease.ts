export class GenerationWorkerLeaseLostError extends Error {
  constructor(message = "Generation job lease is no longer owned by this worker.") {
    super(message);
    this.name = "GenerationWorkerLeaseLostError";
  }
}

export function isGenerationWorkerLeaseLostError(
  error: unknown,
): error is GenerationWorkerLeaseLostError {
  return error instanceof GenerationWorkerLeaseLostError;
}

export function throwIfGenerationWorkerLeaseLost(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (isGenerationWorkerLeaseLostError(signal.reason) || signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new GenerationWorkerLeaseLostError();
}
