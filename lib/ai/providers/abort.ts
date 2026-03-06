export function attachAbortSignal(
  controller: AbortController,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => {};

  const abort = () => {
    try {
      controller.abort();
    } catch {
      // ignore repeated aborts
    }
  };

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
