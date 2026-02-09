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
    <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-card/70 via-bg/40 to-accent/15 shadow-soft ring-1 ring-border backdrop-blur sm:h-9 sm:w-9">
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
  // Avoid SSR/CSR mismatch: the server always renders light, so hydrate as light then
  // sync from DOM/localStorage after mount.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(getInitialTheme());
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
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-b from-bg/70 to-bg/45 text-muted ring-1 ring-border/80 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.06)] transition hover:from-bg/80 hover:to-bg/55 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-10 sm:w-10"
      onClick={toggleTheme}
    >
      <svg aria-hidden="true" className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none">
        {theme === "dark" ? (
          <path
            d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m0-11.314L7.05 7.05m9.9 9.9 1.414 1.414M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        ) : (
          <path
            d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        )}
      </svg>
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
          ? "inline-flex h-11 shrink-0 items-center rounded-full bg-card/75 px-4 text-[13px] font-semibold text-fg shadow-soft ring-1 ring-border sm:h-10 sm:px-4 sm:text-sm"
          : "inline-flex h-11 shrink-0 items-center rounded-full px-4 text-[13px] text-muted transition hover:bg-bg/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-10 sm:px-4 sm:text-sm"
      }
      href={href}
    >
      {label}
    </Link>
  );
}

function SocialIconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      aria-label={label}
      className="inline-flex h-11 w-11 items-center justify-center text-muted transition hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50 sm:h-10 sm:w-10"
      href={href}
      rel="noreferrer"
      target="_blank"
      title={label}
    >
      {children}
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="relative sticky top-0 z-20 border-b border-border bg-bg/75 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[92rem] flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-4 lg:px-8">
        <a
          href="#main"
          className="sr-only rounded-full bg-card/80 px-4 py-2 text-sm text-fg ring-1 ring-border focus:not-sr-only focus:absolute focus:left-4 focus:top-3"
        >
          Skip to content
        </a>

        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-start sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link className="group flex min-w-0 items-center gap-3" href="/">
              <CubeMark />
              <div className="leading-tight">
                <div className="font-display text-base font-semibold tracking-tight text-fg sm:text-sm">
                  <span className="text-fg">Mine</span>
                  <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">
                    Bench
                  </span>
                </div>
              </div>
            </Link>
            <div className="hidden h-5 w-px bg-border/70 sm:block" aria-hidden="true" />
          </div>

          <div className="flex items-center rounded-full bg-bg/50 px-0.5 ring-1 ring-border/70 sm:bg-transparent sm:px-0 sm:ring-0">
            <SocialIconLink
              href="https://www.linkedin.com/in/ammaar-alam/"
              label="Ammaar Alam on LinkedIn"
            >
              <svg
                aria-hidden="true"
                className="h-[18px] w-[18px]"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M22.225 0H1.771C.792 0 0 .774 0 1.727v20.545C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.273V1.727C24 .774 23.2 0 22.222 0zM7.06 20.452H3.56V9h3.5v11.452zM5.31 7.433c-1.12 0-2.03-.92-2.03-2.06 0-1.14.91-2.06 2.03-2.06 1.12 0 2.03.92 2.03 2.06 0 1.14-.91 2.06-2.03 2.06zM20.45 20.452h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.95v5.66H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28z" />
              </svg>
            </SocialIconLink>
            <SocialIconLink href="https://ammaaralam.com" label="Ammaar Alam website">
              <svg
                aria-hidden="true"
                className="h-[22px] w-[22px]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              >
                <path d="M12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9-9 4.03-9 9 4.03 9 9 9Z" />
                <path d="M3 12h18" />
                <path d="M12 3c2.5 2.46 4 5.68 4 9s-1.5 6.54-4 9c-2.5-2.46-4-5.68-4-9s1.5-6.54 4-9Z" />
              </svg>
            </SocialIconLink>
            <SocialIconLink
              href="https://github.com/Ammaar-Alam/minebench"
              label="MineBench on GitHub"
            >
              <svg
                aria-hidden="true"
                className="h-[22px] w-[22px]"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 2a10 10 0 0 0-3.162 19.492c.5.092.682-.217.682-.482 0-.237-.009-.866-.014-1.699-2.776.603-3.362-1.339-3.362-1.339-.455-1.156-1.11-1.465-1.11-1.465-.908-.62.069-.607.069-.607 1.004.07 1.532 1.031 1.532 1.031.892 1.529 2.341 1.087 2.91.832.091-.647.349-1.087.635-1.338-2.217-.252-4.555-1.108-4.555-4.932 0-1.09.39-1.982 1.029-2.68-.103-.252-.446-1.268.098-2.642 0 0 .84-.269 2.75 1.025a9.563 9.563 0 0 1 2.503-.336c.85.004 1.705.115 2.503.336 1.909-1.294 2.748-1.025 2.748-1.025.546 1.374.203 2.39.1 2.642.64.698 1.028 1.59 1.028 2.68 0 3.834-2.342 4.677-4.566 4.924.359.309.678.919.678 1.852 0 1.337-.012 2.415-.012 2.743 0 .267.18.578.688.48A10 10 0 0 0 12 2Z" />
              </svg>
            </SocialIconLink>
          </div>
        </div>

        <nav className="grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded-[1.15rem] bg-bg/55 p-1 shadow-soft ring-1 ring-border sm:flex sm:w-auto sm:flex-nowrap sm:items-center sm:gap-1 sm:rounded-full">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <NavLink href="/" label="Arena" />
            <NavLink href="/sandbox" label="Sandbox" />
            <NavLink href="/local" label="Local" />
            <NavLink href="/leaderboard" label="Leaderboard" />
          </div>
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
