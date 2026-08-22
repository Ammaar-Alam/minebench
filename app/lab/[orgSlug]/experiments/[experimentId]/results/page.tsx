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
    rating: variant.conservativeRating,
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
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold tracking-tight text-fg">Results</h2>
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
