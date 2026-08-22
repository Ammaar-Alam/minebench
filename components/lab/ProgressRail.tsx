export function ProgressRail({
  completed,
  expected,
  label,
}: {
  completed: number;
  expected: number;
  label: string;
}) {
  const percent = expected > 0 ? Math.min(100, Math.round((completed / expected) * 100)) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-xs text-muted">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-fg">
          {completed.toLocaleString()} / {expected.toLocaleString()}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-border/45"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, expected)}
        aria-valuenow={completed}
        aria-valuetext={`${completed} of ${expected}`}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
