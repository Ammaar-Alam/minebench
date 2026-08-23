"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  ["overview", "Overview"],
  ["builds", "Builds"],
  ["results", "Results"],
  ["settings", "Settings"],
] as const;

export function EvaluationNav({ basePath }: { basePath: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Evaluation" className="overflow-x-auto [scrollbar-width:none]">
      <div className="flex min-w-max gap-7 border-b border-border/70">
        {items.map(([segment, label]) => {
          const href = `${basePath}/${segment}`;
          const active = pathname === href;
          return (
            <Link
              key={segment}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-11 items-center text-sm transition-colors focus-visible:outline-none focus-visible:text-accent ${
                active ? "font-medium text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {label}
              <span
                aria-hidden="true"
                className={`absolute inset-x-0 bottom-0 h-px origin-left bg-fg transition-transform duration-200 ease-out motion-reduce:transition-none ${
                  active ? "scale-x-100" : "scale-x-0"
                }`}
              />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
