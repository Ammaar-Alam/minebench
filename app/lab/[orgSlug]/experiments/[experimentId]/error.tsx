"use client";

export default function EvaluationError({ reset }: { reset: () => void }) {
  return (
    <section className="border-y border-danger/30 py-7" role="alert">
      <h2 className="text-xl font-semibold tracking-tight text-fg">Evaluation unavailable</h2>
      <button type="button" onClick={reset} className="mb-btn mb-btn-ghost mt-4 min-h-11 px-5 text-sm">
        Try again
      </button>
    </section>
  );
}
