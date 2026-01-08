"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const THEME_KEY = "mb-theme";

function getInitialTheme(): Theme {
  if (typeof document !== "undefined") {
    const fromDom = document.documentElement.dataset.theme;
    if (fromDom === "dark" || fromDom === "light") return fromDom;
  }
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch {}
  }
  return "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {}
}

function CubeMark() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-card/70 via-bg/40 to-accent/15 shadow-soft ring-1 ring-border backdrop-blur">
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

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      if (e.newValue === "dark" || e.newValue === "light") {
        setTheme(e.newValue);
        applyTheme(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  return (
    <button
      type="button"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-full px-3 py-2 text-sm text-muted transition hover:bg-card/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onClick={toggleTheme}
    >
      <span className="flex items-center gap-2">
        <span className="hidden sm:inline">{theme === "dark" ? "Light" : "Dark"}</span>
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none">
          {theme === "dark" ? (
            <path
              d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m0-11.314L7.05 7.05m9.9 9.9 1.414 1.414M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
          ) : (
            <path
              d="M21 13.2A7.5 7.5 0 0 1 10.8 3a6.8 6.8 0 1 0 10.2 10.2Z"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
          )}
        </svg>
      </span>
    </button>
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
              <span className="text-fg">Mine</span>
              <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">
                Bench
              </span>
            </div>
            <div className="text-xs text-muted">
              A/B voxel builds • Elo arena • sandbox
            </div>
          </div>
        </Link>

        <nav className="flex items-center gap-1 rounded-full bg-bg/50 p-1 shadow-soft ring-1 ring-border">
          <NavLink href="/" label="Arena" />
          <NavLink href="/sandbox" label="Sandbox" />
          <NavLink href="/leaderboard" label="Leaderboard" />
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
