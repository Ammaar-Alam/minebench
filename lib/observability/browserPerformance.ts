let traceSequence = 0;

export type BrowserPerformanceTrace = {
  mark: (stage: string) => number;
  measure: (name: string, startStage: string, endStage: string) => number | null;
  duration: (startStage: string, endStage: string) => number | null;
};

export function createBrowserPerformanceTrace(kind: string): BrowserPerformanceTrace {
  traceSequence += 1;
  const prefix = `minebench:arena:${kind}:${traceSequence}`;
  const marks = new Map<string, number>();

  const mark = (stage: string): number => {
    const at = performance.now();
    marks.set(stage, at);
    try {
      performance.mark(`${prefix}:${stage}`, { startTime: at });
    } catch {
      // Performance entries are diagnostic only
    }
    return at;
  };

  const duration = (startStage: string, endStage: string): number | null => {
    const startedAt = marks.get(startStage);
    const endedAt = marks.get(endStage);
    if (startedAt == null || endedAt == null || endedAt < startedAt) return null;
    return endedAt - startedAt;
  };

  return {
    mark,
    duration,
    measure(name, startStage, endStage) {
      const measured = duration(startStage, endStage);
      if (measured == null) return null;
      try {
        performance.measure(`${prefix}:${name}`, {
          start: `${prefix}:${startStage}`,
          end: `${prefix}:${endStage}`,
        });
      } catch {
        // Performance entries are diagnostic only
      }
      return measured;
    },
  };
}
