import type { Metadata } from "next";
import Link from "next/link";
import { EvaluationNav } from "@/components/lab/EvaluationNav";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { loadEvaluationWorkspace } from "./data";

export const metadata: Metadata = {
  title: "Evaluation",
  robots: { index: false, follow: false },
};

export default async function EvaluationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const basePath = `/lab/${orgSlug}/experiments/${experimentId}`;
  const checkpoints = workspace.checkpoints.filter((checkpoint) => checkpoint.status !== "WITHDRAWN");
  const buildCount = checkpoints.reduce((total, checkpoint) => total + checkpoint.generatedBuildCount, 0);
  const expectedBuildCount = checkpoints.reduce(
    (total, checkpoint) => total + checkpoint.expectedBuildCount,
    0,
  );
  const decisiveVotes = checkpoints.reduce((total, checkpoint) => total + checkpoint.decisiveVotes, 0);

  return (
    <div className="mx-auto w-full max-w-[86rem] space-y-7 py-5 sm:py-9">
      <header className="space-y-4">
        <Link
          href={`/lab/${orgSlug}`}
          className="inline-flex min-h-9 items-center gap-2 text-xs font-medium text-muted transition hover:text-fg focus-visible:outline-none focus-visible:text-accent"
        >
          <span aria-hidden="true">←</span>
          {workspace.organization.name}
        </Link>
        <div className="grid gap-5 rounded-3xl border border-border/70 bg-card/55 p-5 shadow-soft sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-3">
              <span className="mb-eyebrow">Evaluation</span>
              <EvaluationStatus status={workspace.status} />
            </div>
            <h1 className="truncate font-display text-2xl font-semibold tracking-[-0.03em] text-fg sm:text-3xl">
              {workspace.name}
            </h1>
          </div>
          <dl className="grid grid-cols-3 divide-x divide-border/70 border-t border-border/70 pt-4 lg:min-w-[22rem] lg:border-t-0 lg:pt-0">
            <div className="pr-4">
              <dt className="text-[10px] uppercase tracking-[0.12em] text-muted2">Checkpoints</dt>
              <dd className="mt-1 font-mono text-sm tabular-nums text-fg">{checkpoints.length}</dd>
            </div>
            <div className="px-4">
              <dt className="text-[10px] uppercase tracking-[0.12em] text-muted2">Builds</dt>
              <dd className="mt-1 font-mono text-sm tabular-nums text-fg">
                {buildCount}/{expectedBuildCount}
              </dd>
            </div>
            <div className="pl-4">
              <dt className="text-[10px] uppercase tracking-[0.12em] text-muted2">Votes</dt>
              <dd className="mt-1 font-mono text-sm tabular-nums text-fg">
                {decisiveVotes.toLocaleString()}
              </dd>
            </div>
          </dl>
        </div>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-9 xl:gap-12">
        <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <EvaluationNav basePath={basePath} />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
