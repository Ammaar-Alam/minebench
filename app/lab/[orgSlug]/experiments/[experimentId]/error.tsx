"use client";

export default function EvaluationError({ reset }: { reset: () => void }) {
  return (
    <section className="border-y border-danger/35 py-8" role="alert">
      <h2 className="text-lg font-medium tracking-tight text-fg">Evaluation unavailable</h2>
      <button type="button" onClick={reset} className="mb-btn mb-btn-ghost mt-4 min-h-11 px-5 text-sm">
        Try again
      </button>
    </section>
  );
}
