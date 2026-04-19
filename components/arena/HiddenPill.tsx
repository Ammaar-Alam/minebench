"use client";

export function HiddenPill() {
  return (
    <span
      aria-label="Model hidden until you vote"
      className="inline-flex items-center text-muted/55"
    >
      <svg
        className="h-3 w-3"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      </svg>
    </span>
  );
}
