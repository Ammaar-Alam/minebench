"use client";

export default function EvaluationError({ reset }: { reset: () => void }) {
  return (
    <section className="rounded-3xl border border-danger/30 bg-card/45 p-7" role="alert">
      <p className="mb-eyebrow text-danger">Unable to load</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-fg">Evaluation unavailable</h2>
      <button type="button" onClick={reset} className="mb-btn mb-btn-ghost mt-4 min-h-11 px-5 text-sm">
        Try again
      </button>
    </section>
  );
}
