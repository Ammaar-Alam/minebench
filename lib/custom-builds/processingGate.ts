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
      tail = previous.then(() => current);
      await previous;

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unlock();
      };
      try {
        signal?.throwIfAborted();
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
