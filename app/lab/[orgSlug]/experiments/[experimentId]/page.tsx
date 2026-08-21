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
  title: "Evaluation",
  robots: { index: false, follow: false },
};

function percent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function date(value: Date | null): string {
  return value ? value.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) : "—";
}

function statusClass(status: string): string {
  if (status === "ACTIVE" || status === "STABLE") return "text-success";
  if (status === "DEGRADED" || status === "WITHDRAWN") return "text-warn";
  return "text-muted";
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function BreakdownTable({
  title,
  label,
  rows,
}: {
  title: string;
  label: string;
  rows: StealthBreakdown[];
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-medium tracking-tight text-fg">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-y border-border/70 text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            <tr className="border-b border-border/45">
              <th className="py-2.5 pr-4 font-medium">{label}</th>
              <th className="px-3 py-2.5 text-right font-medium">Votes</th>
              <th className="px-3 py-2.5 text-right font-medium">Record</th>
              <th className="py-2.5 pl-4 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/35 last:border-0">
                <td className="max-w-[30rem] py-3 pr-4 text-fg">
                  <span className="line-clamp-2">{row.label}</span>
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                  {row.votes}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                  {row.wins}–{row.losses}–{row.draws}
                </td>
                <td className="py-3 pl-4 text-right font-mono text-xs tabular-nums text-fg">
                  {percent(row.averageScore)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-sm text-muted">
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
  const period = [
    report.startsAt ? `Started ${date(report.startsAt)}` : null,
    report.endedAt ? `Ended ${date(report.endedAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10 py-6 sm:py-12">
      <header className="space-y-6 border-b border-border/70 pb-7">
        <Link
          href={`/lab/${orgSlug}`}
          className="inline-flex text-sm text-muted transition hover:text-fg"
        >
          ← {report.organization.name}
        </Link>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                {report.name}
              </h1>
              <span
                className={`inline-flex items-center gap-2 text-xs font-medium ${statusClass(report.status)}`}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                {statusLabel(report.status)}
              </span>
            </div>
            {period ? <p className="text-sm text-muted">{period}</p> : null}
          </div>
          {exportAvailable ? (
            <a
              href={`/api/lab/organizations/${orgSlug}/experiments/${report.id}/export`}
              className="mb-btn mb-btn-ghost h-10 px-4 text-xs"
            >
              Export
            </a>
          ) : null}
        </div>
      </header>

      {report.variants.map((variant) => (
        <article key={variant.id} className="space-y-8 border-b border-border/70 pb-10 last:border-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-2xl font-semibold tracking-tight text-fg">{variant.codename}</h2>
              <p className="text-sm text-muted">
                {variant.releasedModelKey ? `Released as ${variant.releasedModelKey}` : variant.stability}
              </p>
            </div>
            <span
              className={`inline-flex w-fit items-center gap-2 text-xs font-medium ${statusClass(variant.status)}`}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              {statusLabel(variant.status)}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-8 gap-y-6 border-y border-border/70 py-5 lg:grid-cols-4">
            {[
              ["Score", percent(variant.outcomes.averageScore)],
              [
                "Record",
                `${variant.outcomes.wins}–${variant.outcomes.losses}–${variant.outcomes.draws}`,
              ],
              ["Estimated rank", `#${variant.estimatedFieldRank} of ${variant.estimatedFieldSize}`],
              [
                "Decisive votes",
                `${variant.outcomes.decisiveVotes.toLocaleString()} / ${variant.targetDecisiveVotes.toLocaleString()}`,
              ],
            ].map(([label, metric]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1.5 text-xl font-semibold tabular-nums text-fg">{metric}</dd>
              </div>
            ))}
          </dl>

          <div
            className="h-1 overflow-hidden rounded-full bg-border/50"
            role="progressbar"
            aria-label="Evaluation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(variant.progress * 100)}
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${variant.progress * 100}%` }}
            />
          </div>

          <div className="space-y-8">
            <BreakdownTable title="By prompt" label="Prompt" rows={variant.prompts} />
            <BreakdownTable title="By model" label="Model" rows={variant.opponents} />
          </div>
        </article>
      ))}

      {report.variants.length === 0 ? (
        <section className="border-y border-border/70 py-8">
          <p className="text-sm text-muted">No checkpoints</p>
        </section>
      ) : null}
    </div>
  );
}
