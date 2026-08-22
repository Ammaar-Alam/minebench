import { BreakdownTable } from "@/components/lab/BreakdownTable";
import { formatPercent } from "@/components/lab/format";
import { loadEvaluationReport } from "../data";

export default async function EvaluationResultsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { report } = await loadEvaluationReport(orgSlug, experimentId);
  const hasVotes = report.variants.some((variant) => variant.outcomes.votes > 0);
  const exportAvailable = report.exportPolicy === "DEIDENTIFIED_VOTES";

  return (
    <div className="space-y-10">
      <section className="space-y-4" aria-labelledby="checkpoint-estimates-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="checkpoint-estimates-heading" className="text-2xl font-semibold tracking-tight text-fg">
              Checkpoint estimates
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Calibrated independently against public models.
            </p>
          </div>
          {exportAvailable ? (
            <a
              href={`/api/lab/organizations/${orgSlug}/experiments/${experimentId}/export`}
              className="mb-btn mb-btn-ghost min-h-11 px-5 text-sm"
            >
              Export
            </a>
          ) : null}
        </div>

        <div className="overflow-x-auto border-y border-border/70">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              <tr className="border-b border-border/45">
                <th className="py-2.5 pr-4 font-medium">Checkpoint</th>
                <th className="px-3 py-2.5 text-right font-medium">Field position</th>
                <th className="px-3 py-2.5 text-right font-medium">Confidence</th>
                <th className="px-3 py-2.5 text-right font-medium">Score</th>
                <th className="py-2.5 pl-3 text-right font-medium">Votes</th>
              </tr>
            </thead>
            <tbody>
              {report.variants.map((variant) => (
                <tr key={variant.id} className="border-b border-border/35 last:border-0">
                  <td className="py-4 pr-4">
                    <div className="font-medium text-fg">{variant.codename}</div>
                    <div className="mt-1 text-xs text-muted">{variant.stability}</div>
                  </td>
                  <td className="px-3 py-4 text-right font-mono text-xs tabular-nums text-fg">
                    {variant.outcomes.decisiveVotes > 0
                      ? `#${variant.estimatedFieldRank} of ${variant.estimatedFieldSize}`
                      : "—"}
                  </td>
                  <td className="px-3 py-4 text-right font-mono text-xs tabular-nums text-fg">
                    {variant.outcomes.decisiveVotes > 0 ? formatPercent(variant.confidence) : "—"}
                  </td>
                  <td className="px-3 py-4 text-right font-mono text-xs tabular-nums text-fg">
                    {formatPercent(variant.outcomes.averageScore)}
                  </td>
                  <td className="py-4 pl-3 text-right font-mono text-xs tabular-nums text-muted">
                    {variant.outcomes.votes.toLocaleString()}
                  </td>
                </tr>
              ))}
              {report.variants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-muted">
                    No checkpoints
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {hasVotes ? (
        report.variants.map((variant) => {
          const coveredPrompts = variant.prompts.filter((prompt) => prompt.decisiveVotes > 0).length;
          return (
            <article key={variant.id} className="space-y-8 border-b border-border/70 pb-10 last:border-0">
              <div className="space-y-5">
                <h2 className="text-2xl font-semibold tracking-tight text-fg">{variant.codename}</h2>
                <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/70 py-5 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted">Prompt coverage</dt>
                    <dd className="mt-1.5 text-xl font-semibold tabular-nums text-fg">
                      {coveredPrompts}/{variant.expectedBuildCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Side balance</dt>
                    <dd className="mt-1.5 text-xl font-semibold tabular-nums text-fg">
                      {formatPercent(variant.sideBalance)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Ties</dt>
                    <dd className="mt-1.5 text-xl font-semibold tabular-nums text-fg">
                      {variant.outcomes.draws.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Both bad</dt>
                    <dd className="mt-1.5 text-xl font-semibold tabular-nums text-fg">
                      {variant.outcomes.bothBad.toLocaleString()}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="grid gap-8 xl:grid-cols-2">
                <BreakdownTable title="By prompt" label="Prompt" rows={variant.prompts} />
                <BreakdownTable title="By public model" label="Model" rows={variant.opponents} />
              </div>
            </article>
          );
        })
      ) : (
        <section className="border-y border-border/70 py-8">
          <h2 className="text-lg font-medium tracking-tight text-fg">No results yet</h2>
          <p className="mt-2 text-sm text-muted">Results appear after Arena voting begins.</p>
        </section>
      )}
    </div>
  );
}
