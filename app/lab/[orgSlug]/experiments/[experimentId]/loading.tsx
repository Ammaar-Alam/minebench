export default function EvaluationLoading() {
  return (
    <div className="mx-auto w-full max-w-[86rem] space-y-6 py-7 sm:py-10" role="status" aria-live="polite">
      <span className="sr-only">Loading evaluation</span>
      <div className="h-40 animate-pulse rounded-3xl border border-border/60 bg-card/45 motion-reduce:animate-none" />
      <div className="grid gap-6 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <div className="h-64 animate-pulse rounded-2xl border border-border/60 bg-card/35 motion-reduce:animate-none" />
        <div className="space-y-5">
          <div className="h-64 animate-pulse rounded-3xl border border-border/60 bg-card/35 motion-reduce:animate-none" />
          <div className="h-32 animate-pulse rounded-3xl border border-border/60 bg-card/35 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
