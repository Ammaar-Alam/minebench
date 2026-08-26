export function VoxelEmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/20 text-sm text-muted">
      <div
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border/70 text-muted/60"
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="M3.3 7l8.7 5 8.7-5" />
          <path d="M12 22v-9" />
        </svg>
      </div>
      <span className="text-xs text-muted/80">No build yet</span>
    </div>
  );
}
