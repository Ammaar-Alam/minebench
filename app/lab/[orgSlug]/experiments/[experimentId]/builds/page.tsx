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
    (checkpoint) => checkpoint.latestGenerationRun?.status === "RUNNING",
  );
  const builds: ProtectedBuildOption[] = report.variants.flatMap((variant) =>
    variant.builds.map((build) => ({
      id: `${variant.id}:${build.promptId}`,
      resultId: build.resultId,
      checkpointId: variant.id,
      checkpoint: variant.codename,
      promptId: build.promptId,
      prompt: build.prompt,
      status: build.status,
      error: build.error,
      blockCount: build.blockCount,
      attempts: build.attempts,
      generationTimeMs: build.generationTimeMs,
    })),
  );
  const readyBuilds = builds.filter((build) => build.status === "READY").length;
  const issueCount = builds.filter((build) => build.status === "FAILED" || build.error).length;

  return (
    <div className="space-y-6">
      <GenerationPoller active={generationActive} />

      <section className="space-y-4" aria-labelledby="cohort-heading">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-eyebrow">Visual review</p>
            <h2 id="cohort-heading" className="mt-1.5 text-2xl font-semibold tracking-tight text-fg">
              Cohort
            </h2>
          </div>
          <div className="flex items-center gap-5 text-xs text-muted">
            <span><strong className="font-mono font-medium tabular-nums text-fg">{readyBuilds}</strong> ready</span>
            {issueCount ? <span className="text-danger">{issueCount} issues</span> : null}
          </div>
        </div>

        {workspace.checkpoints.length > 0 ? (
          <div className="overflow-x-auto pb-1 [scrollbar-width:thin]">
            <div className="flex min-w-max gap-3">
              {workspace.checkpoints.map((checkpoint) => {
                const running = checkpoint.latestGenerationRun?.status === "RUNNING";
                const canStart =
                  workspace.status !== "CLOSED" &&
                  checkpoint.credentialConfigured &&
                  !running &&
                  (checkpoint.expectedBuildCount === 0 ||
                    checkpoint.generatedBuildCount < checkpoint.expectedBuildCount);
                const startAction = startGenerationAction.bind(
                  null,
                  orgSlug,
                  experimentId,
                  checkpoint.id,
                );
                const percent = checkpoint.expectedBuildCount
                  ? Math.min(
                      100,
                      Math.round(
                        (checkpoint.generatedBuildCount / checkpoint.expectedBuildCount) * 100,
                      ),
                    )
                  : 0;

                return (
                  <article
                    key={checkpoint.id}
                    className="w-[18rem] rounded-2xl border border-border/70 bg-card/45 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-fg">{checkpoint.codename}</h3>
                        <div className="mt-1.5"><EvaluationStatus status={checkpoint.status} /></div>
                      </div>
                      <span className="font-mono text-xs tabular-nums text-muted">
                        {checkpoint.generatedBuildCount}/{checkpoint.expectedBuildCount}
                      </span>
                    </div>
                    <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-border/45">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
                    </div>
                    {canStart ? (
                      <form action={startAction} className="mt-4 border-t border-border/55 pt-3">
                        <input type="hidden" name="maxAttempts" value="3" />
                        <button type="submit" className="mb-btn mb-btn-primary h-10 w-full px-4 text-xs">
                          Generate
                        </button>
                      </form>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-card/30 p-6">
            <Link
              href={`/lab/${orgSlug}/experiments/${experimentId}/settings`}
              className="text-sm font-medium text-accent hover:underline"
            >
              Add checkpoint →
            </Link>
          </div>
        )}
      </section>

      <ProtectedBuildInspector orgSlug={orgSlug} builds={builds} />
    </div>
  );
}
