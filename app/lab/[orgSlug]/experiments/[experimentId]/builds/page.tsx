import Link from "next/link";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { GenerationPoller } from "@/components/lab/GenerationPoller";
import {
  ProtectedBuildInspector,
  type ProtectedBuildOption,
} from "@/components/lab/ProtectedBuildInspector";
import { ProgressRail } from "@/components/lab/ProgressRail";
import { formatDuration, titleCase } from "@/components/lab/format";
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
  const protectedBuilds: ProtectedBuildOption[] = report.variants.flatMap((variant) =>
    variant.builds.flatMap((build) =>
      build.resultId && build.status === "READY"
        ? [
            {
              resultId: build.resultId,
              checkpoint: variant.codename,
              prompt: build.prompt,
              blockCount: build.blockCount,
              attempts: build.attempts,
              generationTimeMs: build.generationTimeMs,
            },
          ]
        : [],
    ),
  );

  return (
    <div className="space-y-10">
      <GenerationPoller active={generationActive} />

      <section className="space-y-4" aria-labelledby="build-progress-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="build-progress-heading" className="text-2xl font-semibold tracking-tight text-fg">
              Builds
            </h2>
            <p className="mt-1 text-sm text-muted">Inspect completed prompts as they arrive.</p>
          </div>
          {workspace.status === "DRAFT" && workspace.checkpoints.length === 0 ? (
            <Link
              href={`/lab/${orgSlug}/experiments/${experimentId}/settings`}
              className="mb-btn mb-btn-primary min-h-11 px-5 text-sm"
            >
              Add checkpoint
            </Link>
          ) : null}
        </div>

        <div className="divide-y divide-border/55 border-y border-border/70">
          {workspace.checkpoints.map((checkpoint) => {
            const variant = report.variants.find((item) => item.id === checkpoint.id);
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

            return (
              <article key={checkpoint.id} className="space-y-5 py-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="truncate text-lg font-medium text-fg">{checkpoint.codename}</h3>
                      <EvaluationStatus status={checkpoint.status} />
                    </div>
                    <p className="text-xs text-muted">{titleCase(checkpoint.source)}</p>
                  </div>
                  {canStart ? (
                    <form action={startAction} className="flex items-end gap-2">
                      <label className="space-y-1 text-xs text-muted">
                        <span className="block">Attempts</span>
                        <input
                          name="maxAttempts"
                          type="number"
                          min={1}
                          max={10}
                          defaultValue={3}
                          className="mb-field h-11 w-20"
                        />
                      </label>
                      <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-4 text-sm">
                        Generate
                      </button>
                    </form>
                  ) : null}
                </div>

                <ProgressRail
                  completed={checkpoint.generatedBuildCount}
                  expected={checkpoint.expectedBuildCount}
                  label="Cohort"
                />

                {variant?.builds.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[42rem] text-left text-sm">
                      <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                        <tr className="border-b border-border/45">
                          <th className="py-2 pr-4 font-medium">Prompt</th>
                          <th className="px-3 py-2 text-right font-medium">Status</th>
                          <th className="px-3 py-2 text-right font-medium">Attempts</th>
                          <th className="py-2 pl-3 text-right font-medium">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {variant.builds.map((build) => (
                          <tr key={build.promptId} className="border-b border-border/35 last:border-0">
                            <td className="max-w-[34rem] py-3 pr-4 text-fg">
                              <span className="line-clamp-2">{build.prompt}</span>
                              {build.error ? (
                                <span className="mt-1 block text-xs text-danger">{build.error}</span>
                              ) : null}
                            </td>
                            <td className="px-3 py-3 text-right">
                              <EvaluationStatus status={build.status} />
                            </td>
                            <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                              {build.attempts}
                            </td>
                            <td className="py-3 pl-3 text-right font-mono text-xs tabular-nums text-muted">
                              {formatDuration(build.generationTimeMs)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted">No prompt activity yet.</p>
                )}
              </article>
            );
          })}
          {workspace.checkpoints.length === 0 ? (
            <div className="py-8 text-sm text-muted">No checkpoints</div>
          ) : null}
        </div>
      </section>

      <ProtectedBuildInspector orgSlug={orgSlug} builds={protectedBuilds} />
    </div>
  );
}
