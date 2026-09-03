const GENERATION_PROVIDER_TIMEOUT_MS = 90 * 60 * 1000;

export function generationProviderSignal(
  signal?: AbortSignal,
  timeoutMs = GENERATION_PROVIDER_TIMEOUT_MS,
): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
