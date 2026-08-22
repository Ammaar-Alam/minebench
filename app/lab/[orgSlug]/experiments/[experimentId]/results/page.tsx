import {
  ResultsDashboard,
  type ResultsDashboardVariant,
} from "@/components/lab/ResultsDashboard";
import { loadEvaluationReport } from "../data";

export default async function EvaluationResultsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { report } = await loadEvaluationReport(orgSlug, experimentId);
  const exportAvailable = report.exportPolicy === "DEIDENTIFIED_VOTES";
  const variants: ResultsDashboardVariant[] = report.variants.map((variant) => ({
    id: variant.id,
    codename: variant.codename,
    rating: variant.rating,
    ratingDeviation: variant.ratingDeviation,
    confidence: variant.confidence,
    stability: variant.stability,
    estimatedFieldRank: variant.estimatedFieldRank,
    estimatedFieldSize: variant.estimatedFieldSize,
    expectedBuildCount: variant.expectedBuildCount,
    sideA: variant.sideA,
    sideB: variant.sideB,
    outcomes: variant.outcomes,
    prompts: variant.prompts,
    opponents: variant.opponents,
  }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-eyebrow">Arena evidence</p>
          <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-fg">Results</h2>
        </div>
        {exportAvailable ? (
          <a
            href={`/api/lab/organizations/${orgSlug}/experiments/${experimentId}/export`}
            className="mb-btn mb-btn-ghost min-h-11 px-5"
          >
            Export votes
          </a>
        ) : null}
      </header>

      <ResultsDashboard variants={variants} />
    </div>
  );
}
