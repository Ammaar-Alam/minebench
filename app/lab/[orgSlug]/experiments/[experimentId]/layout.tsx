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

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 py-6 sm:py-10">
      <header className="space-y-6">
        <Link
          href={`/lab/${orgSlug}`}
          className="inline-flex min-h-11 items-center text-sm text-muted transition hover:text-fg focus-visible:outline-none focus-visible:text-accent"
        >
          ← {workspace.organization.name}
        </Link>
        <div className="flex flex-col gap-3 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="truncate text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              {workspace.name}
            </h1>
            <EvaluationStatus status={workspace.status} />
          </div>
          <span className="text-xs text-muted">
            {workspace.checkpoints.filter((checkpoint) => checkpoint.status !== "WITHDRAWN").length} checkpoints
          </span>
        </div>
        <EvaluationNav basePath={basePath} />
      </header>
      {children}
    </div>
  );
}
