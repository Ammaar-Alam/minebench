"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function CubeMark() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-xl bg-card/60 shadow-soft ring-1 ring-border">
      <svg
        aria-hidden="true"
        className="h-5 w-5 text-accent"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          d="M12 2 4.5 6.2v11.6L12 22l7.5-4.2V6.2L12 2Z"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
        <path
          d="M12 2v20M4.5 6.2 12 10.4l7.5-4.2"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full bg-card/70 px-3 py-2 text-sm font-medium text-fg shadow-soft ring-1 ring-border"
          : "rounded-full px-3 py-2 text-sm text-muted transition hover:bg-card/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      }
      href={href}
    >
      {label}
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 -mx-4 border-b border-border bg-bg/75 px-4 py-4 backdrop-blur">
      <div className="flex items-center justify-between gap-4">
        <Link className="group flex items-center gap-3" href="/">
          <CubeMark />
          <div className="leading-tight">
            <div className="font-display text-sm font-semibold tracking-tight text-fg">
              MineBench
            </div>
            <div className="text-xs text-muted">
              A/B voxel builds • Elo arena • sandbox
            </div>
          </div>
        </Link>

        <nav className="flex items-center gap-1 rounded-full bg-bg/50 p-1 ring-1 ring-border">
          <NavLink href="/" label="Arena" />
          <NavLink href="/sandbox" label="Sandbox" />
          <NavLink href="/leaderboard" label="Leaderboard" />
        </nav>
      </div>
    </header>
  );
}
