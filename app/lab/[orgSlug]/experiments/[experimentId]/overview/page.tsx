import Link from "next/link";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { GenerationPoller } from "@/components/lab/GenerationPoller";
import { LifecycleActionButton } from "@/components/lab/LifecycleActionButton";
import { ProgressRail } from "@/components/lab/ProgressRail";
import { formatDate, titleCase } from "@/components/lab/format";
import {
  activateEvaluationAction,
  pauseEvaluationAction,
  resumeEvaluationAction,
} from "../../../actions";
import { loadEvaluationWorkspace } from "../data";

const stages = ["Setup", "Build", "Ready", "Arena", "Review"] as const;

const statusTitles: Record<string, string> = {
  DRAFT: "Prepare the field",
  GENERATING: "Builds in progress",
  READY: "Ready for Arena",
  ACTIVE: "Collecting evidence",
  PAUSED: "Sampling paused",
  CLOSED: "Evaluation closed",
};

function lifecycleStep(status: string): number {
  if (status === "GENERATING") return 1;
  if (status === "READY") return 2;
  if (status === "ACTIVE" || status === "PAUSED") return 3;
  if (status === "CLOSED") return 4;
  return 0;
}

export default async function EvaluationOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const generationActive = workspace.checkpoints.some(
    (checkpoint) => checkpoint.latestGenerationRun?.status === "RUNNING",
  );
  const basePath = `/lab/${orgSlug}/experiments/${experimentId}`;
  const activateAction = activateEvaluationAction.bind(null, orgSlug, experimentId);
  const pauseAction = pauseEvaluationAction.bind(null, orgSlug, experimentId);
  const resumeAction = resumeEvaluationAction.bind(null, orgSlug, experimentId);
  const currentStep = lifecycleStep(workspace.status);
  const pausedAtGoal =
    workspace.pauseAtGoal &&
    workspace.targetDecisiveVotes != null &&
    workspace.checkpoints.length > 0 &&
    workspace.checkpoints.every(
      (checkpoint) => checkpoint.decisiveVotes >= workspace.targetDecisiveVotes!,
    );
  const canResume = workspace.status === "PAUSED" && !workspace.endedAt && !pausedAtGoal;

  return (
    <div className="space-y-8">
      <GenerationPoller active={generationActive} />

      <section className="py-1">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-fg">
            {statusTitles[workspace.status] ?? statusTitles.DRAFT}
          </h2>
          <div className="flex flex-wrap gap-2">
            {workspace.status === "DRAFT" ? (
              <Link href={`${basePath}/settings`} className="mb-btn mb-btn-primary min-h-11 px-5">
                Add checkpoint
              </Link>
            ) : null}
            {workspace.status === "GENERATING" ? (
              <Link href={`${basePath}/builds`} className="mb-btn mb-btn-primary min-h-11 px-5">
                View builds
              </Link>
            ) : null}
            {workspace.status === "READY" ? (
              <form action={activateAction}>
                <LifecycleActionButton label="Activate" pendingLabel="Activating…" tone="primary" />
              </form>
            ) : null}
            {workspace.status === "ACTIVE" ? (
              <form action={pauseAction}>
                <LifecycleActionButton label="Pause" pendingLabel="Pausing…" tone="ghost" />
              </form>
            ) : null}
            {canResume ? (
              <form action={resumeAction}>
                <LifecycleActionButton label="Resume" pendingLabel="Resuming…" tone="primary" />
              </form>
            ) : null}
          </div>
        </div>

        <ol className="mt-6 grid grid-cols-5 border-t border-border/60 pt-3">
          {stages.map((stage, index) => {
            const reached = index <= currentStep;
            const active = index === currentStep;
            return (
              <li key={stage} className="relative text-[10px] text-muted sm:text-xs">
                <span
                  aria-hidden="true"
                  className={`absolute -top-[0.85rem] left-0 h-px ${reached ? "w-full bg-fg" : "w-0 bg-transparent"}`}
                />
                <span className={active ? "font-medium text-fg" : ""}>{stage}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="checkpoint-heading">
        <h2 id="checkpoint-heading" className="pb-4 text-lg font-semibold tracking-tight text-fg">
          Checkpoints
        </h2>

        {workspace.checkpoints.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border/70 px-4">
            <div className="hidden grid-cols-[minmax(10rem,0.85fr)_minmax(12rem,1.2fr)_8rem] gap-6 border-b border-border/55 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted2 md:grid">
              <span>Checkpoint</span>
              <span>Builds</span>
              <span className="text-right">Evidence</span>
            </div>
            {workspace.checkpoints.map((checkpoint) => (
              <article
                key={checkpoint.id}
                className="grid gap-5 border-b border-border/50 py-5 last:border-0 md:grid-cols-[minmax(10rem,0.85fr)_minmax(12rem,1.2fr)_8rem] md:items-center md:gap-6"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="truncate text-sm font-medium text-fg">{checkpoint.codename}</h3>
                    <EvaluationStatus
                      status={
                        checkpoint.lastGenerationError && checkpoint.status === "DRAFT"
                          ? "FAILED"
                          : checkpoint.status
                      }
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {titleCase(checkpoint.source)}
                    {checkpoint.cohortGeneratedAt ? ` · ${formatDate(checkpoint.cohortGeneratedAt)}` : ""}
                  </p>
                </div>
                <ProgressRail
                  completed={checkpoint.generatedBuildCount}
                  expected={checkpoint.expectedBuildCount}
                  label="Builds"
                />
                <div className="flex items-end justify-between gap-5 md:block md:text-right">
                  <div>
                    <p className="font-mono text-sm tabular-nums text-fg">
                      {checkpoint.decisiveVotes.toLocaleString()}
                    </p>
                    <p className="mt-1 text-[10px] text-muted">decisive</p>
                  </div>
                  {checkpoint.generationFailureCount > 0 ? (
                    <p className="text-xs text-danger md:mt-2">
                      {checkpoint.generationFailureCount.toLocaleString()} failed
                    </p>
                  ) : null}
                </div>
                {checkpoint.lastGenerationError ? (
                  <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-2 text-xs text-danger md:col-span-3"
                  >
                    <span className="min-w-0 break-words">{checkpoint.lastGenerationError}</span>
                    {checkpoint.status === "DRAFT" && checkpoint.source === "ENDPOINT" ? (
                      <Link
                        href={`${basePath}/settings?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                        className="shrink-0 font-medium text-fg underline hover:text-accent"
                      >
                        Edit endpoint settings
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="py-8">
            <Link href={`${basePath}/settings`} className="text-sm font-medium text-accent hover:underline">
              Add checkpoint
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
