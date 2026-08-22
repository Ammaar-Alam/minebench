"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  ["overview", "Overview", "Health"],
  ["builds", "Builds", "Explore"],
  ["results", "Results", "Evidence"],
  ["settings", "Settings", "Control"],
] as const;

function NavIcon({ segment }: { segment: (typeof items)[number][0] }) {
  if (segment === "overview") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
        <path d="M3.5 10.5h4v6h-4zM8 3.5h4v13H8zM12.5 7h4v9.5h-4z" stroke="currentColor" strokeWidth="1.35" />
      </svg>
    );
  }
  if (segment === "builds") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
        <path d="m10 2.8 6.2 3.4v7.3L10 17l-6.2-3.5V6.2L10 2.8Z" stroke="currentColor" strokeWidth="1.35" />
        <path d="m3.9 6.3 6.1 3.4 6.1-3.4M10 9.7V17" stroke="currentColor" strokeWidth="1.35" />
      </svg>
    );
  }
  if (segment === "results") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
        <path d="M3 15.5h14M4.5 13V9.8M8.2 13V6.5M11.8 13V8M15.5 13V4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
      <circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10 2.8v2M10 15.2v2M17.2 10h-2M4.8 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export function EvaluationNav({ basePath }: { basePath: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Evaluation" className="overflow-x-auto [scrollbar-width:none] lg:overflow-visible">
      <div className="flex min-w-max gap-1 rounded-2xl border border-border/70 bg-card/55 p-1.5 shadow-soft lg:min-w-0 lg:flex-col lg:bg-card/35">
        {items.map(([segment, label, detail]) => {
          const href = `${basePath}/${segment}`;
          const active = pathname === href;
          return (
            <Link
              key={segment}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`group flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 lg:min-h-14 ${
                active
                  ? "bg-bg/85 font-medium text-fg shadow-sm ring-1 ring-border/80"
                  : "text-muted hover:bg-bg/45 hover:text-fg"
              }`}
            >
              <span className={active ? "text-accent" : "text-muted2 group-hover:text-muted"}>
                <NavIcon segment={segment} />
              </span>
              <span className="flex flex-col">
                <span>{label}</span>
                <span className="hidden text-[10px] font-normal text-muted2 lg:block">{detail}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
