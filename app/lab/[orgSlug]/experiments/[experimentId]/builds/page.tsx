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
  const issueCount = builds.filter((build) => build.status === "FAILED" || build.error).length;

  return (
    <div className="space-y-10">
      <GenerationPoller active={generationActive} />

      <section aria-labelledby="cohort-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-4 pb-4">
          <h2 id="cohort-heading" className="text-2xl font-semibold tracking-tight text-fg">
            Builds
          </h2>
          {issueCount ? <span className="text-xs text-danger">{issueCount} issues</span> : null}
        </div>

        {workspace.checkpoints.length > 0 ? (
          <div className="border-y border-border/70">
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
                  className="grid gap-4 border-b border-border/50 py-4 last:border-0 sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_auto] sm:items-center sm:gap-6"
                >
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-fg">{checkpoint.codename}</h3>
                    <div className="mt-1.5"><EvaluationStatus status={checkpoint.status} /></div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-3 font-mono text-xs tabular-nums text-muted">
                      <span>Generation</span>
                      <span className="text-fg">
                        {checkpoint.generatedBuildCount}/{checkpoint.expectedBuildCount}
                      </span>
                    </div>
                    <div className="mt-2 h-px bg-border/60">
                      <div className="h-px bg-accent" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                  {canStart ? (
                    <form action={startAction}>
                      <input type="hidden" name="maxAttempts" value="3" />
                      <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-4 text-xs">
                        Generate
                      </button>
                    </form>
                  ) : (
                    <span className="hidden w-24 sm:block" />
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="border-y border-border/70 py-8">
            <Link
              href={`/lab/${orgSlug}/experiments/${experimentId}/settings`}
              className="text-sm font-medium text-accent hover:underline"
            >
              Add checkpoint
            </Link>
          </div>
        )}
      </section>

      <ProtectedBuildInspector orgSlug={orgSlug} builds={builds} />
    </div>
  );
}
