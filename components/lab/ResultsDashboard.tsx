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
    <section className="rounded-3xl border border-border/70 bg-card/55 p-5 shadow-soft sm:p-6" aria-labelledby="field-position-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-eyebrow">Public field</p>
          <h2 id="field-position-heading" className="mt-1.5 text-xl font-semibold tracking-tight text-fg">
            Estimated position
          </h2>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-muted">
          #1 <span aria-hidden="true">←</span> public field <span aria-hidden="true">→</span> #{fieldSize}
        </span>
      </div>

      <div className="mt-6 space-y-2">
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
              onClick={() => onSelect(variant.id)}
              className={`grid min-h-16 w-full gap-3 rounded-2xl px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 sm:grid-cols-[minmax(8rem,0.55fr)_minmax(12rem,1fr)_auto] sm:items-center ${
                active ? "bg-bg/70 ring-1 ring-border/80" : "hover:bg-bg/40"
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-fg">{variant.codename}</span>
                <span className="mt-0.5 block text-[10px] text-muted">{variant.stability}</span>
              </span>
              <span className="relative block h-6" aria-hidden="true">
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                <span className="absolute left-0 top-1/2 h-2 w-px -translate-y-1/2 bg-muted2/55" />
                <span className="absolute right-0 top-1/2 h-2 w-px -translate-y-1/2 bg-muted2/55" />
                {hasEvidence ? (
                  <span
                    className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card ${active ? "bg-accent shadow-[0_0_0_4px_hsl(var(--accent)_/_0.16)]" : "bg-muted2"}`}
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
    <section className="rounded-3xl border border-border/70 bg-card/45 p-5 sm:p-6" aria-labelledby="outcome-mix-heading">
      <div className="flex items-start justify-between gap-5">
        <div>
          <p className="mb-eyebrow">Preference</p>
          <h3 id="outcome-mix-heading" className="mt-1.5 text-lg font-semibold tracking-tight text-fg">
            Outcome mix
          </h3>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums text-fg">{formatPercent(outcomes.averageScore)}</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-muted2">Score</p>
        </div>
      </div>

      <div
        className="mt-7 flex h-4 overflow-hidden rounded-full bg-border/40"
        aria-label={`${outcomes.wins} wins, ${outcomes.draws} ties, ${outcomes.losses} losses, ${outcomes.bothBad} both bad`}
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
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${segment.className}`} />
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
    <section className="rounded-3xl border border-border/70 bg-card/45 p-5 sm:p-6" aria-labelledby="evidence-quality-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="mb-eyebrow">Signal</p>
          <h3 id="evidence-quality-heading" className="mt-1.5 text-lg font-semibold tracking-tight text-fg">
            Evidence quality
          </h3>
        </div>
        <span className="rounded-full border border-border/70 bg-bg/50 px-2.5 py-1 text-[10px] font-medium text-muted">
          {variant.stability}
        </span>
      </div>
      <dl className="mt-6 space-y-5">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-xs text-muted">{metric.label}</dt>
              <dd className="font-mono text-xs tabular-nums text-fg">{metric.text}</dd>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/45">
              <div className="h-full rounded-full bg-accent" style={{ width: `${clampPercent(metric.value)}%` }} />
            </div>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex items-end justify-between border-t border-border/55 pt-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.1em] text-muted2">Rating</p>
          <p className="mt-1 font-mono text-sm tabular-nums text-fg">{Math.round(variant.rating)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-[0.1em] text-muted2">Deviation</p>
          <p className="mt-1 font-mono text-sm tabular-nums text-fg">±{Math.round(variant.ratingDeviation)}</p>
        </div>
      </div>
    </section>
  );
}

function BreakdownVisual({
  title,
  eyebrow,
  rows,
}: {
  title: string;
  eyebrow: string;
  rows: StealthBreakdown[];
}) {
  const sortedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (b.averageScore ?? -1) - (a.averageScore ?? -1) || b.votes - a.votes,
      ),
    [rows],
  );

  return (
    <section className="min-w-0 rounded-3xl border border-border/70 bg-card/45 p-5 sm:p-6">
      <p className="mb-eyebrow">{eyebrow}</p>
      <h3 className="mt-1.5 text-lg font-semibold tracking-tight text-fg">{title}</h3>
      <div className="mt-5 flex items-center justify-between px-1 text-[9px] uppercase tracking-[0.1em] text-muted2">
        <span>Lower</span>
        <span>50%</span>
        <span>Higher</span>
      </div>
      <div className="mt-2 max-h-[30rem] space-y-1 overflow-y-auto overscroll-contain pr-1">
        {sortedRows.map((row) => {
          const score = row.averageScore;
          const scorePercent = score == null ? 50 : clampPercent(score);
          const lower = Math.min(50, scorePercent);
          const width = Math.abs(scorePercent - 50);

          return (
            <div key={row.id} className="rounded-xl px-2 py-3 hover:bg-bg/40">
              <div className="flex items-center justify-between gap-4">
                <span title={row.label} className="min-w-0 truncate text-xs font-medium text-fg">
                  {row.label}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-fg">
                  {formatPercent(score)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-border/40">
                  <span className="absolute inset-y-0 left-1/2 w-px bg-muted2/70" />
                  {score != null ? (
                    <span
                      className={`absolute inset-y-0 rounded-full ${score >= 0.5 ? "bg-accent" : "bg-danger/70"}`}
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
        {rows.length === 0 ? <p className="py-6 text-sm text-muted">No votes yet.</p> : null}
      </div>
    </section>
  );
}

export function ResultsDashboard({ variants }: { variants: ResultsDashboardVariant[] }) {
  const firstWithVotes = variants.find((variant) => variant.outcomes.votes > 0) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstWithVotes?.id ?? "");
  const selected = variants.find((variant) => variant.id === selectedId) ?? variants[0] ?? null;

  if (!selected) {
    return (
      <div className="rounded-3xl border border-dashed border-border bg-card/30 p-8 text-sm text-muted">
        Add a checkpoint to begin.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FieldPosition variants={variants} selectedId={selected.id} onSelect={setSelectedId} />

      {variants.length > 1 ? (
        <div className="overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Checkpoint results">
          <div className="flex min-w-max gap-2">
            {variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                role="tab"
                aria-selected={variant.id === selected.id}
                onClick={() => setSelectedId(variant.id)}
                className={`min-h-11 rounded-full px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                  variant.id === selected.id
                    ? "bg-accent/15 text-accent ring-1 ring-accent/35"
                    : "bg-card/45 text-muted ring-1 ring-border/70 hover:text-fg"
                }`}
              >
                {variant.codename}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {selected.outcomes.votes > 0 ? (
        <>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
            <OutcomeMix outcomes={selected.outcomes} />
            <EvidenceQuality variant={selected} />
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            <BreakdownVisual title="Prompt landscape" eyebrow="Strengths and gaps" rows={selected.prompts} />
            <BreakdownVisual title="Opponent field" eyebrow="Public anchors" rows={selected.opponents} />
          </div>
        </>
      ) : (
        <div className="rounded-3xl border border-dashed border-border bg-card/30 p-8 sm:p-10">
          <h2 className="text-xl font-semibold tracking-tight text-fg">Waiting for evidence</h2>
          <p className="mt-2 text-sm text-muted">Results appear after Arena voting begins.</p>
        </div>
      )}

      <details className="group rounded-2xl border border-border/60 bg-card/30">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45">
          How to read this
          <span aria-hidden="true" className="text-lg transition-transform group-open:rotate-45 motion-reduce:transition-none">+</span>
        </summary>
        <div className="grid gap-4 border-t border-border/55 px-4 py-5 text-xs leading-5 text-muted sm:grid-cols-3">
          <p>Field position uses each checkpoint’s conservative rating against public models.</p>
          <p>Preference score counts a win as one point and a tie as half a point.</p>
          <p>Checkpoints are calibrated independently; their ordering is an estimate, not a head-to-head record.</p>
        </div>
      </details>
    </div>
  );
}
