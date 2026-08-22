"use client";

import { useMemo, useState } from "react";
import { formatPercent } from "@/components/lab/format";
import type {
  StealthBreakdown,
  StealthOutcomeSummary,
  StealthVariantReport,
} from "@/lib/stealth/report";

export type ResultsDashboardVariant = Pick<
  StealthVariantReport,
  | "id"
  | "codename"
  | "rating"
  | "ratingDeviation"
  | "confidence"
  | "stability"
  | "estimatedFieldRank"
  | "estimatedFieldSize"
  | "expectedBuildCount"
  | "sideA"
  | "sideB"
  | "outcomes"
  | "prompts"
  | "opponents"
>;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value * 100));
}

function FieldPosition({
  variants,
  selectedId,
  onSelect,
}: {
  variants: ResultsDashboardVariant[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const fieldSize = Math.max(1, ...variants.map((variant) => variant.estimatedFieldSize));

  return (
    <section className="border-y border-border/70 py-6" aria-labelledby="field-position-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="field-position-heading" className="text-lg font-semibold tracking-tight text-fg">
          Estimated field position
        </h2>
        <span className="font-mono text-[10px] tabular-nums text-muted">
          #1 <span aria-hidden="true">←</span> field <span aria-hidden="true">→</span> #{fieldSize}
        </span>
      </div>

      <div className="mt-5 divide-y divide-border/45">
        {variants.map((variant) => {
          const hasEvidence = variant.outcomes.decisiveVotes > 0;
          const position =
            variant.estimatedFieldSize > 1
              ? ((variant.estimatedFieldRank - 1) / (variant.estimatedFieldSize - 1)) * 100
              : 50;
          const active = variant.id === selectedId;

          return (
            <button
              key={variant.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(variant.id)}
              className={`grid min-h-16 w-full gap-3 px-2 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 sm:grid-cols-[minmax(8rem,0.55fr)_minmax(12rem,1fr)_auto] sm:items-center ${
                active ? "bg-card/35" : "hover:bg-card/20"
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">{variant.codename}</span>
                <span className="mt-0.5 block text-[10px] text-muted">{variant.stability}</span>
              </span>
              <span className="relative block h-6" aria-hidden="true">
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                <span className="absolute left-0 top-1/2 h-2 w-px -translate-y-1/2 bg-muted2/55" />
                <span className="absolute right-0 top-1/2 h-2 w-px -translate-y-1/2 bg-muted2/55" />
                {hasEvidence ? (
                  <span
                    className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg ${active ? "bg-accent" : "bg-muted2"}`}
                    style={{ left: `${Math.max(1, Math.min(99, position))}%` }}
                  />
                ) : null}
              </span>
              <span className="text-left sm:min-w-24 sm:text-right">
                <span className="block font-mono text-sm tabular-nums text-fg">
                  {hasEvidence ? `#${variant.estimatedFieldRank}` : "—"}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted">
                  {hasEvidence ? `of ${variant.estimatedFieldSize}` : "Waiting"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OutcomeMix({ outcomes }: { outcomes: StealthOutcomeSummary }) {
  const segments = [
    { label: "Wins", value: outcomes.wins, className: "bg-success" },
    { label: "Ties", value: outcomes.draws, className: "bg-muted2" },
    { label: "Losses", value: outcomes.losses, className: "bg-danger/75" },
    { label: "Both bad", value: outcomes.bothBad, className: "bg-warn/75" },
  ];
  const total = outcomes.votes;

  return (
    <section className="p-5 sm:p-6" aria-labelledby="outcome-mix-heading">
      <div className="flex items-start justify-between gap-5">
        <h3 id="outcome-mix-heading" className="text-base font-semibold tracking-tight text-fg">
          Outcome mix
        </h3>
        <div className="text-right">
          <p className="font-mono text-2xl tabular-nums text-fg">{formatPercent(outcomes.averageScore)}</p>
          <p className="mt-1 text-[10px] text-muted">score</p>
        </div>
      </div>

      <div
        className="mt-7 flex h-2 overflow-hidden bg-border/40"
        aria-hidden="true"
      >
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={segment.className}
            style={{ width: total > 0 ? `${(segment.value / total) * 100}%` : "0%" }}
          />
        ))}
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {segments.map((segment) => (
          <div key={segment.label}>
            <dt className="flex items-center gap-2 text-xs text-muted">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${segment.className}`} />
              {segment.label}
            </dt>
            <dd className="mt-1.5 font-mono text-sm tabular-nums text-fg">
              {segment.value.toLocaleString()}
              <span className="ml-1.5 text-[10px] text-muted2">
                {total ? `${Math.round((segment.value / total) * 100)}%` : "—"}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function EvidenceQuality({ variant }: { variant: ResultsDashboardVariant }) {
  const coveredPrompts = variant.prompts.filter((prompt) => prompt.decisiveVotes > 0).length;
  const promptCoverage = coveredPrompts / Math.max(1, variant.expectedBuildCount);
  const sideTotal = variant.sideA + variant.sideB;
  const sideA = sideTotal > 0 ? variant.sideA / sideTotal : null;
  const metrics = [
    { label: "Confidence", value: variant.confidence, text: formatPercent(variant.confidence) },
    { label: "Prompt coverage", value: promptCoverage, text: `${coveredPrompts}/${variant.expectedBuildCount}` },
    {
      label: "Side split",
      value: sideA == null ? 0 : 1 - Math.abs(0.5 - sideA) * 2,
      text: sideA == null ? "—" : `${Math.round(sideA * 100)} / ${Math.round((1 - sideA) * 100)}`,
    },
  ];

  return (
    <section className="p-5 sm:p-6" aria-labelledby="evidence-quality-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h3 id="evidence-quality-heading" className="text-base font-semibold tracking-tight text-fg">
          Evidence quality
        </h3>
        <span className="text-xs text-muted">{variant.stability}</span>
      </div>
      <dl className="mt-6 space-y-5">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-xs text-muted">{metric.label}</dt>
              <dd className="font-mono text-xs tabular-nums text-fg">{metric.text}</dd>
            </div>
            <div className="mt-2 h-1 bg-border/45">
              <div className="h-full bg-fg/65" style={{ width: `${clampPercent(metric.value)}%` }} />
            </div>
          </div>
        ))}
      </dl>
      <dl className="mt-6 grid grid-cols-2 border-t border-border/55 pt-4">
        <div>
          <dt className="text-[10px] text-muted">Rating</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-fg">{Math.round(variant.rating)}</dd>
        </div>
        <div className="text-right">
          <dt className="text-[10px] text-muted">Deviation</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-fg">±{Math.round(variant.ratingDeviation)}</dd>
        </div>
      </dl>
    </section>
  );
}

function BreakdownVisual({ title, rows }: { title: string; rows: StealthBreakdown[] }) {
  const sortedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (b.averageScore ?? -1) - (a.averageScore ?? -1) || b.votes - a.votes,
      ),
    [rows],
  );

  return (
    <section className="min-w-0 p-5 sm:p-6">
      <h3 className="text-base font-semibold tracking-tight text-fg">{title}</h3>
      <div className="mt-5 flex items-center justify-between text-[9px] text-muted2">
        <span>Lower</span>
        <span>50%</span>
        <span>Higher</span>
      </div>
      <div className="mt-2 max-h-[30rem] divide-y divide-border/40 overflow-y-auto overscroll-contain">
        {sortedRows.map((row) => {
          const score = row.averageScore;
          const scorePercent = score == null ? 50 : clampPercent(score);
          const lower = Math.min(50, scorePercent);
          const width = Math.abs(scorePercent - 50);

          return (
            <div key={row.id} className="py-3">
              <div className="flex items-center justify-between gap-4">
                <span title={row.label} className="min-w-0 truncate text-xs font-medium text-fg">
                  {row.label}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-fg">
                  {formatPercent(score)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="relative h-1.5 flex-1 bg-border/40">
                  <span className="absolute inset-y-0 left-1/2 w-px bg-muted2/70" />
                  {score != null ? (
                    <span
                      className={`absolute inset-y-0 ${score >= 0.5 ? "bg-fg/70" : "bg-danger/70"}`}
                      style={{ left: `${lower}%`, width: `${Math.max(1, width)}%` }}
                    />
                  ) : null}
                </div>
                <span className="w-14 text-right font-mono text-[10px] tabular-nums text-muted">
                  {row.votes} votes
                </span>
              </div>
            </div>
          );
        })}
        {rows.length === 0 ? <p className="py-6 text-sm text-muted">No votes yet</p> : null}
      </div>
    </section>
  );
}

export function ResultsDashboard({ variants }: { variants: ResultsDashboardVariant[] }) {
  const firstWithVotes = variants.find((variant) => variant.outcomes.votes > 0) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstWithVotes?.id ?? "");
  const selected = variants.find((variant) => variant.id === selectedId) ?? variants[0] ?? null;

  if (!selected) {
    return <div className="border-y border-border/70 py-8 text-sm text-muted">Add a checkpoint to begin</div>;
  }

  return (
    <div className="space-y-10">
      <FieldPosition variants={variants} selectedId={selected.id} onSelect={setSelectedId} />

      {selected.outcomes.votes > 0 ? (
        <>
          <div className="grid border-y border-border/70 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)] xl:divide-x xl:divide-border/60">
            <OutcomeMix outcomes={selected.outcomes} />
            <div className="border-t border-border/60 xl:border-t-0">
              <EvidenceQuality variant={selected} />
            </div>
          </div>
          <div className="grid border-y border-border/70 xl:grid-cols-2 xl:divide-x xl:divide-border/60">
            <BreakdownVisual title="Prompt landscape" rows={selected.prompts} />
            <div className="border-t border-border/60 xl:border-t-0">
              <BreakdownVisual title="Opponent field" rows={selected.opponents} />
            </div>
          </div>
        </>
      ) : (
        <div className="border-y border-border/70 py-8">
          <h2 className="text-lg font-semibold tracking-tight text-fg">Waiting for evidence</h2>
        </div>
      )}

      <details className="group border-y border-border/60">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45">
          Method notes
          <span aria-hidden="true" className="text-lg transition-transform group-open:rotate-45 motion-reduce:transition-none">+</span>
        </summary>
        <div className="grid gap-4 border-t border-border/55 py-5 text-xs leading-5 text-muted sm:grid-cols-3">
          <p>Position uses each checkpoint’s conservative rating against the public field.</p>
          <p>A win is one point; a tie is half a point.</p>
          <p>Checkpoint ordering is an estimate, not a head-to-head record.</p>
        </div>
      </details>
    </div>
  );
}
