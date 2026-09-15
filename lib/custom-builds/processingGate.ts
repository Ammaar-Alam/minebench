export function createCustomBuildProcessingGate(): {
  acquire: (signal?: AbortSignal) => Promise<() => void>;
} {
  let tail = Promise.resolve();

  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      let unlock = () => {};
      const current = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const previous = tail;
      // canceled waiters still wait their turn before advancing the queue
      tail = previous.then(() => current);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unlock();
      };
      let cleanup = () => {};
      try {
        await (signal ? Promise.race([
          previous,
          new Promise<never>((_, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            cleanup = () => signal.removeEventListener("abort", abort);
          }),
        ]) : previous);
        signal?.throwIfAborted();
        return release;
      } catch (error) {
        release();
        throw error;
      } finally {
        cleanup();
      }
    },
  };
}
