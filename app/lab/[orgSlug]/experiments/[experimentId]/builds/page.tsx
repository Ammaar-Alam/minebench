import Link from "next/link";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { GenerationPoller } from "@/components/lab/GenerationPoller";
import {
  ProtectedBuildInspector,
  type ProtectedBuildOption,
} from "@/components/lab/ProtectedBuildInspector";
import { startGenerationAction } from "../../../actions";
import { loadEvaluationReport } from "../data";

export default async function EvaluationBuildsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { workspace, report } = await loadEvaluationReport(orgSlug, experimentId);
  const generationActive = workspace.checkpoints.some(
    (checkpoint) =>
      checkpoint.status !== "WITHDRAWN" &&
      checkpoint.latestGenerationRun?.status === "RUNNING" &&
      (checkpoint.source === "ENDPOINT" ||
        checkpoint.latestGenerationRun.results.some(
          (result) =>
            (result.status === "QUEUED" && result.uploadPending) ||
            result.status === "GENERATING" ||
            result.status === "VALIDATING",
        )),
  );
  const pendingCheckpoints = workspace.checkpoints.filter(
    (checkpoint) =>
      checkpoint.status !== "WITHDRAWN" &&
      (checkpoint.latestGenerationRun?.status === "RUNNING" ||
        !checkpoint.promptCohortCurrent ||
        checkpoint.currentGeneratedBuildCount < checkpoint.currentExpectedBuildCount),
  );
  const builds: ProtectedBuildOption[] = report.variants.flatMap((variant) =>
    variant.builds.map((build) => ({
      id: `${variant.id}:${build.promptId}`,
      resultId: build.resultId,
      checkpointId: variant.id,
      checkpoint: variant.codename,
      checkpointStatus: variant.status,
      promptId: build.promptId,
      prompt: build.prompt,
      status: build.status,
      error: build.error,
      blockCount: build.blockCount,
      attempts: build.attempts,
      generationTimeMs: build.generationTimeMs,
    })),
  );
  return (
    <div className="space-y-6">
      <GenerationPoller active={generationActive} />

      {workspace.checkpoints.length > 0 ? (
        <>
          {pendingCheckpoints.length > 0 ? (
            <section className="overflow-hidden rounded-md border border-border/70" aria-labelledby="generation-heading">
              <div className="flex items-center justify-between gap-4 bg-card/20 px-4 py-3">
                <h2 id="generation-heading" className="text-sm font-medium text-fg">Build progress</h2>
                <span className="font-mono text-[10px] tabular-nums text-muted">
                  {pendingCheckpoints.length} incomplete
                </span>
              </div>
              <div className="divide-y divide-border/50">
                {pendingCheckpoints.map((checkpoint) => {
                  const running =
                    checkpoint.latestGenerationRun?.status === "RUNNING" &&
                    (checkpoint.source === "ENDPOINT" ||
                      checkpoint.latestGenerationRun.results.some(
                        (result) =>
                          (result.status === "QUEUED" && result.uploadPending) ||
                          result.status === "GENERATING" ||
                          result.status === "VALIDATING",
                      ));
                  const canStart =
                    workspace.status !== "CLOSED" &&
                    checkpoint.source === "ENDPOINT" &&
                    checkpoint.credentialConfigured &&
                    !running &&
                    (!checkpoint.promptCohortCurrent ||
                      checkpoint.currentGeneratedBuildCount < checkpoint.currentExpectedBuildCount);
                  const startAction = startGenerationAction.bind(
                    null,
                    orgSlug,
                    experimentId,
                    checkpoint.id,
                  );
                  const percent = checkpoint.currentExpectedBuildCount
                    ? Math.min(
                        100,
                        Math.round(
                          (checkpoint.currentGeneratedBuildCount /
                            checkpoint.currentExpectedBuildCount) *
                            100,
                        ),
                      )
                    : 0;

                  return (
                    <article
                      key={checkpoint.id}
                      className="grid gap-4 px-4 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_auto] sm:items-center sm:gap-6"
                    >
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-medium text-fg">{checkpoint.codename}</h3>
                        <div className="mt-1.5">
                          <EvaluationStatus
                            status={
                              checkpoint.lastGenerationError && checkpoint.status === "DRAFT"
                                ? "FAILED"
                                : checkpoint.status
                            }
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between gap-3 font-mono text-xs tabular-nums text-muted">
                          <span>Builds</span>
                          <span className="text-fg">
                            {checkpoint.currentGeneratedBuildCount}/
                            {checkpoint.currentExpectedBuildCount}
                          </span>
                        </div>
                        <div className="mt-2 h-px bg-border/60">
                          <div className="h-px bg-accent" style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                      {canStart ? (
                        <form action={startAction} className="flex flex-wrap items-center justify-end gap-2.5">
                          <input type="hidden" name="maxAttempts" value="3" />
                          <label className="flex items-center gap-1.5 text-xs text-muted">
                            <span>Parallel</span>
                            <input
                              name="concurrency"
                              type="number"
                              min={1}
                              max={15}
                              defaultValue={1}
                              className="mb-field h-10 w-16 px-2 text-center text-xs"
                              aria-label="Generation concurrency"
                            />
                          </label>
                          <button type="submit" className="mb-btn mb-btn-primary min-h-10 px-4 text-xs">
                            {checkpoint.lastGenerationError || checkpoint.generationFailureCount > 0
                              ? "Retry generation"
                              : checkpoint.currentGeneratedBuildCount > 0
                                ? "Resume generation"
                                : "Generate"}
                          </button>
                        </form>
                      ) : checkpoint.source === "UPLOAD" ? (
                        <Link
                          href={`/lab/${orgSlug}/experiments/${experimentId}/settings?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                          className="mb-btn mb-btn-ghost min-h-11 px-4 text-xs"
                        >
                          Upload builds
                        </Link>
                      ) : !checkpoint.promptCohortCurrent && !running ? (
                        <Link
                          href={`/lab/${orgSlug}/experiments/${experimentId}/settings?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                          className="mb-btn mb-btn-ghost min-h-11 px-4 text-xs"
                        >
                          Refresh
                        </Link>
                      ) : (
                        <span className="hidden w-24 sm:block" />
                      )}
                      {checkpoint.lastGenerationError ? (
                        <div className="col-span-full flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs text-danger">
                          <span className="min-w-0 break-words">
                            <span className="font-medium">Error:</span> {checkpoint.lastGenerationError}
                          </span>
                          {checkpoint.source === "ENDPOINT" ? (
                            <Link
                              href={`/lab/${orgSlug}/experiments/${experimentId}/settings?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                              className="shrink-0 font-medium text-fg underline hover:text-accent"
                            >
                              Edit endpoint settings
                            </Link>
                          ) : (
                            <Link
                              href={`/lab/${orgSlug}/experiments/${experimentId}/settings?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                              className="shrink-0 font-medium text-fg underline hover:text-accent"
                            >
                              Review uploads
                            </Link>
                          )}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          <ProtectedBuildInspector orgSlug={orgSlug} builds={builds} />
        </>
      ) : (
        <section className="py-8">
          <h2 className="text-lg font-semibold tracking-tight text-fg">No checkpoints</h2>
          <p className="mt-2 text-sm text-muted">Add one to begin.</p>
          <div className="mt-4">
            <Link
              href={`/lab/${orgSlug}/experiments/${experimentId}/settings`}
              className="text-sm font-medium text-accent hover:underline"
            >
              Add checkpoint
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
