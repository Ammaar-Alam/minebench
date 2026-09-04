type CheckpointGenerationState = {
  status: string;
  source: string;
  latestGenerationRun: {
    status: string;
    results: ReadonlyArray<{ status: string; uploadPending: boolean }>;
  } | null;
};

export function shouldPollStealthGeneration(checkpoint: CheckpointGenerationState): boolean {
  const run = checkpoint.latestGenerationRun;
  if (checkpoint.status === "WITHDRAWN" || run?.status !== "RUNNING") return false;
  if (checkpoint.source === "ENDPOINT") return true;

  return (
    run.results.some(
      (result) =>
        (result.status === "QUEUED" && result.uploadPending) ||
        result.status === "GENERATING" ||
        result.status === "VALIDATING",
    ) ||
    (run.results.length > 0 && run.results.every((result) => result.status === "READY"))
  );
}
