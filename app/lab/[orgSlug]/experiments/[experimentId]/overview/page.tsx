import Link from "next/link";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { GenerationPoller } from "@/components/lab/GenerationPoller";
import { ProgressRail } from "@/components/lab/ProgressRail";
import { formatDate, titleCase } from "@/components/lab/format";
import {
  activateEvaluationAction,
  pauseEvaluationAction,
  resumeEvaluationAction,
} from "../../../actions";
import { loadEvaluationWorkspace } from "../data";

export default async function EvaluationOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const builds = workspace.checkpoints.reduce(
    (total, checkpoint) => ({
      completed: total.completed + checkpoint.generatedBuildCount,
      expected: total.expected + checkpoint.expectedBuildCount,
    }),
    { completed: 0, expected: 0 },
  );
  const decisiveVotes = workspace.checkpoints.reduce(
    (total, checkpoint) => total + checkpoint.decisiveVotes,
    0,
  );
  const generationActive = workspace.checkpoints.some(
    (checkpoint) => checkpoint.latestGenerationRun?.status === "RUNNING",
  );
  const basePath = `/lab/${orgSlug}/experiments/${experimentId}`;
  const activateAction = activateEvaluationAction.bind(null, orgSlug, experimentId);
  const pauseAction = pauseEvaluationAction.bind(null, orgSlug, experimentId);
  const resumeAction = resumeEvaluationAction.bind(null, orgSlug, experimentId);

  return (
    <div className="space-y-10">
      <GenerationPoller active={generationActive} />

      <section className="grid gap-8 border-y border-border/70 py-6 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight text-fg">{titleCase(workspace.status)}</h2>
            <EvaluationStatus status={workspace.status} />
          </div>
          <p className="max-w-xl text-sm text-muted">
            {workspace.status === "DRAFT" ? "Configure checkpoints and prepare their builds." : null}
            {workspace.status === "GENERATING" ? "Completed builds are ready to inspect." : null}
            {workspace.status === "READY" ? "Every checkpoint is ready for Arena." : null}
            {workspace.status === "ACTIVE" ? "Sampling is active." : null}
            {workspace.status === "PAUSED" ? "Sampling is paused." : null}
            {workspace.status === "CLOSED" ? "Results remain available until deletion." : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {workspace.status === "DRAFT" ? (
              <Link href={`${basePath}/settings`} className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                Add checkpoint
              </Link>
            ) : null}
            {workspace.status === "GENERATING" ? (
              <Link href={`${basePath}/builds`} className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                View builds
              </Link>
            ) : null}
            {workspace.status === "READY" ? (
              <form action={activateAction}>
                <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                  Activate
                </button>
              </form>
            ) : null}
            {workspace.status === "ACTIVE" ? (
              <form action={pauseAction}>
                <button type="submit" className="mb-btn mb-btn-ghost min-h-11 px-5 text-sm">
                  Pause
                </button>
              </form>
            ) : null}
            {workspace.status === "PAUSED" ? (
              <form action={resumeAction}>
                <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                  Resume
                </button>
              </form>
            ) : null}
            {["ACTIVE", "PAUSED", "CLOSED"].includes(workspace.status) ? (
              <Link href={`${basePath}/results`} className="mb-btn mb-btn-ghost min-h-11 px-5 text-sm">
                Results
              </Link>
            ) : null}
          </div>
        </div>

        <div className="space-y-5">
          <ProgressRail completed={builds.completed} expected={builds.expected} label="Builds" />
          {workspace.targetDecisiveVotes ? (
            <ProgressRail
              completed={decisiveVotes}
              expected={workspace.targetDecisiveVotes * Math.max(1, workspace.checkpoints.length)}
              label="Decisive votes"
            />
          ) : (
            <div className="flex items-center justify-between border-y border-border/55 py-3 text-xs text-muted">
              <span>Decisive votes</span>
              <span className="font-mono tabular-nums text-fg">{decisiveVotes.toLocaleString()}</span>
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="checkpoint-heading">
        <div className="flex items-center justify-between gap-4">
          <h2 id="checkpoint-heading" className="text-xl font-semibold tracking-tight text-fg">
            Checkpoints
          </h2>
          <span className="font-mono text-xs text-muted">{workspace.checkpoints.length}</span>
        </div>

        {workspace.checkpoints.length > 0 ? (
          <div className="divide-y divide-border/55 border-y border-border/70">
            {workspace.checkpoints.map((checkpoint) => (
              <article
                key={checkpoint.id}
                className="grid gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)] sm:items-center"
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="truncate text-lg font-medium text-fg">{checkpoint.codename}</h3>
                    <EvaluationStatus status={checkpoint.status} />
                  </div>
                  <p className="text-xs text-muted">
                    {titleCase(checkpoint.source)}
                    {checkpoint.cohortGeneratedAt
                      ? ` · Completed ${formatDate(checkpoint.cohortGeneratedAt)}`
                      : ""}
                  </p>
                  {checkpoint.lastGenerationError ? (
                    <p role="alert" className="text-xs text-danger">
                      {checkpoint.lastGenerationError}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-3">
                  <ProgressRail
                    completed={checkpoint.generatedBuildCount}
                    expected={checkpoint.expectedBuildCount}
                    label="Cohort"
                  />
                  <div className="flex justify-between text-xs text-muted">
                    <span>{checkpoint.totalVotes.toLocaleString()} votes</span>
                    <span>{checkpoint.generationFailureCount.toLocaleString()} failed</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="border-y border-border/70 py-8 text-sm text-muted">No checkpoints</div>
        )}
      </section>
    </div>
  );
}
