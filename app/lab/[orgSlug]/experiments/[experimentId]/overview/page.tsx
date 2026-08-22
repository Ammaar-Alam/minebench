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

const stages = ["Setup", "Build", "Ready", "Arena", "Review"] as const;

const statusCopy: Record<string, { title: string; detail: string }> = {
  DRAFT: { title: "Shape the cohort", detail: "Configure checkpoints, then build." },
  GENERATING: { title: "Builds are arriving", detail: "Inspect the cohort as it lands." },
  READY: { title: "Ready for Arena", detail: "The checkpoint set is complete." },
  ACTIVE: { title: "Evidence is live", detail: "Arena sampling is in progress." },
  PAUSED: { title: "Evidence on hold", detail: "Results remain available." },
  CLOSED: { title: "Evaluation complete", detail: "Review and export the evidence." },
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
  const currentStep = lifecycleStep(workspace.status);
  const copy = statusCopy[workspace.status] ?? statusCopy.DRAFT;
  const buildPercent = builds.expected > 0 ? Math.round((builds.completed / builds.expected) * 100) : 0;
  const voteTarget = workspace.targetDecisiveVotes
    ? workspace.targetDecisiveVotes * Math.max(1, workspace.checkpoints.length)
    : null;

  return (
    <div className="space-y-7">
      <GenerationPoller active={generationActive} />

      <section className="overflow-hidden rounded-3xl border border-border/70 bg-card/65 shadow-soft">
        <div className="grid gap-6 p-5 sm:p-7 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="space-y-3">
            <EvaluationStatus status={workspace.status} />
            <div>
              <h2 className="font-display text-2xl font-semibold tracking-[-0.035em] text-fg sm:text-3xl">
                {copy.title}
              </h2>
              <p className="mt-2 text-sm text-muted">{copy.detail}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {workspace.status === "DRAFT" ? (
              <Link href={`${basePath}/settings`} className="mb-btn mb-btn-primary min-h-11 px-5">
                Add checkpoint
              </Link>
            ) : null}
            {workspace.status === "GENERATING" ? (
              <Link href={`${basePath}/builds`} className="mb-btn mb-btn-primary min-h-11 px-5">
                Explore builds
              </Link>
            ) : null}
            {workspace.status === "READY" ? (
              <form action={activateAction}>
                <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5">
                  Activate
                </button>
              </form>
            ) : null}
            {workspace.status === "ACTIVE" ? (
              <form action={pauseAction}>
                <button type="submit" className="mb-btn mb-btn-ghost min-h-11 px-5">
                  Pause
                </button>
              </form>
            ) : null}
            {workspace.status === "PAUSED" ? (
              <form action={resumeAction}>
                <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5">
                  Resume
                </button>
              </form>
            ) : null}
            {(["ACTIVE", "PAUSED", "CLOSED"] as string[]).includes(workspace.status) ? (
              <Link href={`${basePath}/results`} className="mb-btn mb-btn-ghost min-h-11 px-5">
                View results
              </Link>
            ) : null}
          </div>
        </div>

        <ol className="grid grid-cols-5 border-t border-border/60 bg-bg/35 px-3 py-4 sm:px-6">
          {stages.map((stage, index) => {
            const complete = index < currentStep;
            const active = index === currentStep;
            return (
              <li key={stage} className="relative flex flex-col items-center gap-2 text-center">
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className={`absolute right-1/2 top-2.5 h-px w-full ${index <= currentStep ? "bg-accent/60" : "bg-border"}`}
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className={`relative z-10 grid h-5 w-5 place-items-center rounded-full border text-[9px] font-semibold ${
                    complete
                      ? "border-accent bg-accent text-bg"
                      : active
                        ? "border-accent bg-card text-accent shadow-[0_0_0_4px_hsl(var(--accent)_/_0.12)]"
                        : "border-border bg-card text-muted2"
                  }`}
                >
                  {complete ? (
                    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none">
                      <path d="m2.2 6.2 2.3 2.3 5.2-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </span>
                <span className={`text-[10px] sm:text-xs ${active ? "font-medium text-fg" : "text-muted2"}`}>
                  {stage}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="grid overflow-hidden rounded-3xl border border-border/70 bg-card/45 md:grid-cols-3">
        <div className="space-y-4 p-5 sm:p-6 md:border-r md:border-border/60">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="mb-eyebrow">Cohort</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-fg">{buildPercent}%</p>
            </div>
            <span className="font-mono text-xs tabular-nums text-muted">
              {builds.completed}/{builds.expected}
            </span>
          </div>
          <ProgressRail completed={builds.completed} expected={builds.expected} label="Build completion" />
        </div>
        <div className="border-t border-border/60 p-5 sm:p-6 md:border-r md:border-t-0">
          <p className="mb-eyebrow">Evidence</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-fg">
            {decisiveVotes.toLocaleString()}
          </p>
          <p className="mt-2 text-xs text-muted">
            {voteTarget ? `${Math.min(100, Math.round((decisiveVotes / voteTarget) * 100))}% of vote goal` : "Decisive votes"}
          </p>
        </div>
        <div className="border-t border-border/60 p-5 sm:p-6 md:border-t-0">
          <p className="mb-eyebrow">Field</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-fg">
            {workspace.checkpoints.length}
          </p>
          <p className="mt-2 text-xs text-muted">
            {workspace.checkpoints.length === 1 ? "Private checkpoint" : "Private checkpoints"}
          </p>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="checkpoint-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="mb-eyebrow">Checkpoint pulse</p>
            <h2 id="checkpoint-heading" className="mt-1.5 text-xl font-semibold tracking-tight text-fg">
              Cohort and evidence
            </h2>
          </div>
          <Link href={`${basePath}/builds`} className="text-xs font-medium text-muted transition hover:text-accent">
            Explore builds →
          </Link>
        </div>

        {workspace.checkpoints.length > 0 ? (
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/40">
            {workspace.checkpoints.map((checkpoint) => (
              <article
                key={checkpoint.id}
                className="grid gap-5 border-b border-border/55 p-5 last:border-0 md:grid-cols-[minmax(10rem,0.85fr)_minmax(12rem,1.2fr)_minmax(9rem,0.75fr)] md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="truncate text-base font-semibold text-fg">{checkpoint.codename}</h3>
                    <EvaluationStatus status={checkpoint.status} />
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
                <div className="grid grid-cols-2 gap-4 text-right md:block">
                  <div>
                    <p className="font-mono text-sm tabular-nums text-fg">
                      {checkpoint.decisiveVotes.toLocaleString()}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-muted2">Decisive</p>
                  </div>
                  <div className="md:mt-3">
                    <p className={checkpoint.generationFailureCount > 0 ? "text-xs text-danger" : "text-xs text-muted"}>
                      {checkpoint.generationFailureCount.toLocaleString()} failed
                    </p>
                  </div>
                </div>
                {checkpoint.lastGenerationError ? (
                  <p role="alert" className="text-xs text-danger md:col-span-3">
                    {checkpoint.lastGenerationError}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-card/30 p-7">
            <p className="text-sm text-muted">Add a checkpoint to begin.</p>
          </div>
        )}
      </section>
    </div>
  );
}
