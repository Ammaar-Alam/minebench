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
    <div className="mx-auto w-full max-w-[78rem] space-y-7 py-5 sm:py-9">
      <header className="space-y-5">
        <Link
          href={`/lab/${orgSlug}`}
          className="inline-flex min-h-11 items-center gap-2 text-xs text-muted transition hover:text-fg focus-visible:outline-none focus-visible:text-accent"
        >
          <span aria-hidden="true">←</span>
          {workspace.organization.name}
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                {workspace.name}
              </h1>
              <EvaluationStatus status={workspace.status} />
            </div>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span><strong className="font-mono font-medium tabular-nums text-fg">{checkpoints.length}</strong> checkpoints</span>
            <span><strong className="font-mono font-medium tabular-nums text-fg">{buildCount}/{expectedBuildCount}</strong> builds</span>
            <span><strong className="font-mono font-medium tabular-nums text-fg">{decisiveVotes.toLocaleString()}</strong> votes</span>
          </p>
        </div>
      </header>
      <EvaluationNav basePath={basePath} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
