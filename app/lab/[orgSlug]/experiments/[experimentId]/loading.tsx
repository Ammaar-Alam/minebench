export default function EvaluationLoading() {
  return (
    <div className="mx-auto w-full max-w-[78rem] space-y-8 py-7 sm:py-10" role="status" aria-live="polite">
      <span className="sr-only">Loading evaluation</span>
      <div className="h-20 animate-pulse border-y border-border/60 bg-card/20 motion-reduce:animate-none" />
      <div className="h-12 animate-pulse border-b border-border/60 bg-card/15 motion-reduce:animate-none" />
      <div className="h-64 animate-pulse border-y border-border/60 bg-card/20 motion-reduce:animate-none" />
    </div>
  );
}
