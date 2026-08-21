import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { canExportStealthVotes } from "@/lib/stealth/policy";
import {
  getStealthExperimentReport,
  type StealthBreakdown,
} from "@/lib/stealth/report";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evaluation report",
  robots: { index: false, follow: false },
};

function percent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function date(value: Date | null): string {
  return value ? value.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) : "—";
}

function statusClass(status: string): string {
  if (status === "ACTIVE" || status === "STABLE") return "bg-success/10 text-success ring-success/25";
  if (status === "DEGRADED" || status === "WITHDRAWN") return "bg-warn/10 text-warn ring-warn/25";
  return "bg-bg/45 text-muted ring-border/65";
}

function BreakdownTable({ title, rows }: { title: string; rows: StealthBreakdown[] }) {
  return (
    <section className="mb-panel overflow-hidden before:hidden">
      <div className="border-b border-border/55 px-4 py-3 sm:px-5">
        <h3 className="font-display text-sm font-semibold tracking-tight text-fg">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            <tr className="border-b border-border/45">
              <th className="px-4 py-2.5 font-medium sm:px-5">Name</th>
              <th className="px-3 py-2.5 text-right font-medium">Votes</th>
              <th className="px-3 py-2.5 text-right font-medium">W–L–T</th>
              <th className="px-4 py-2.5 text-right font-medium sm:px-5">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/35 last:border-0">
                <td className="max-w-[30rem] px-4 py-3 text-fg sm:px-5">
                  <span className="line-clamp-2">{row.label}</span>
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                  {row.votes}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                  {row.wins}–{row.losses}–{row.draws}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-fg sm:px-5">
                  {percent(row.averageScore)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-sm text-muted">
                  No votes yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function LabExperimentPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) redirect("/lab/sign-in");
  const report = await getStealthExperimentReport(experimentId);
  if (!report || report.organization.id !== context.membership.organization.id) notFound();
  const exportAvailable =
    report.exportPolicy === "DEIDENTIFIED_VOTES" && canExportStealthVotes(context.membership.role);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7 py-6 sm:py-10">
      <header className="space-y-5">
        <Link
          href={`/lab/${orgSlug}`}
          className="inline-flex font-mono text-xs text-muted transition hover:text-fg"
        >
          ← {report.organization.name}
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mb-eyebrow">Evaluation report</span>
              <span
                className={`inline-flex rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ring-1 ${statusClass(report.status)}`}
              >
                {report.status.toLowerCase()}
              </span>
            </div>
            <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              {report.name}
            </h1>
            <p className="text-sm text-muted">
              Started {date(report.startsAt)}{report.endedAt ? ` · Ended ${date(report.endedAt)}` : ""}
            </p>
          </div>
          {exportAvailable ? (
            <a
              href={`/api/lab/organizations/${orgSlug}/experiments/${report.id}/export`}
              className="mb-btn mb-btn-ghost h-10 px-4 text-xs"
            >
              Export votes
            </a>
          ) : null}
        </div>
      </header>

      {report.variants.map((variant) => (
        <article key={variant.id} className="space-y-4">
          <section className="mb-panel overflow-hidden p-5 before:hidden sm:p-6">
            <div className="mb-panel-inner space-y-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Stealth checkpoint</span>
                  <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
                    {variant.codename}
                  </h2>
                  <p className="text-sm text-muted">
                    {variant.releasedModelKey ? `Released as ${variant.releasedModelKey}` : variant.stability}
                  </p>
                </div>
                <span
                  className={`inline-flex w-fit rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ring-1 ${statusClass(variant.status)}`}
                >
                  {variant.status.toLowerCase()}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/55 ring-1 ring-border/55 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ["Record", `${variant.outcomes.wins}–${variant.outcomes.losses}–${variant.outcomes.draws}`],
                  ["Score", percent(variant.outcomes.averageScore)],
                  ["Field estimate", `#${variant.estimatedFieldRank} / ${variant.estimatedFieldSize}`],
                  ["Confidence", `${variant.confidence}%`],
                  ["Rating deviation", Math.round(variant.ratingDeviation).toString()],
                  ["Side split", `${variant.sideA} / ${variant.sideB}`],
                ].map(([label, metric]) => (
                  <div key={label} className="bg-card/80 px-3 py-4 sm:px-4">
                    <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted">{label}</div>
                    <div className="mt-1.5 text-lg font-semibold tabular-nums text-fg">{metric}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted">Decisive vote target</span>
                  <span className="font-mono tabular-nums text-fg">
                    {variant.outcomes.decisiveVotes.toLocaleString()} / {variant.targetDecisiveVotes.toLocaleString()}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/50">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${variant.progress * 100}%` }} />
                </div>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border/55 pt-4 text-xs text-muted">
                <span>Cohort {variant.generatedBuildCount}/{variant.expectedBuildCount}</span>
                <span>Both bad {variant.outcomes.bothBad}</span>
                <span>Prompt spread {percent(variant.promptScoreSpread)}</span>
                {variant.pendingVotes > 0 ? <span>{variant.pendingVotes} votes processing</span> : null}
                {variant.latestGenerationRun ? (
                  <span>Last generation {variant.latestGenerationRun.status.toLowerCase()}</span>
                ) : null}
              </div>
            </div>
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <BreakdownTable title="Prompt performance" rows={variant.prompts} />
            <BreakdownTable title="Public opponents" rows={variant.opponents} />
          </div>
        </article>
      ))}

      {report.variants.length === 0 ? (
        <section className="mb-panel p-7 text-center before:hidden">
          <p className="text-sm text-muted">This evaluation has no configured variants.</p>
        </section>
      ) : null}

      <footer className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border/50 pt-5 text-xs text-muted">
        <span>{report.exportPolicy === "DEIDENTIFIED_VOTES" ? "Deidentified export enabled" : "Aggregate reporting"}</span>
        {report.agreementReference ? <span>Agreement {report.agreementReference}</span> : null}
        {report.retentionDeleteAt ? <span>Retention through {date(report.retentionDeleteAt)}</span> : null}
      </footer>
    </div>
  );
}
