"use client";

import { useId, useState, type ReactNode } from "react";

export function LabDisclosure({
  title,
  children,
  defaultOpen = false,
  className = "",
  buttonClassName = "",
  panelClassName = "",
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  buttonClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const buttonId = useId();
  const panelId = useId();

  return (
    <div className={`t-acc ${className}`} data-open={open}>
      <button
        id={buttonId}
        type="button"
        className={`t-acc-head group flex min-h-12 w-full items-center justify-start gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 ${buttonClassName}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {title}
        <span className="t-acc-chevron shrink-0 text-muted group-hover:text-fg" aria-hidden="true">
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 6.5L8 10.5L12 6.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div
        id={panelId}
        className="t-acc-panel"
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!open}
      >
        <div
          className={`t-acc-panel-inner ${panelClassName}`}
          inert={!open ? true : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
