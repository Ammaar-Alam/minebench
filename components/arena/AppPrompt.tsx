"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

const APP_STORE_URL = "https://apps.apple.com/app/minebench/id6803704037?ct=web-arena";
// Safari shows Apple's own banner from the page metadata; other iPhone browsers and in-app views need this card
const NON_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|Instagram|FBAN|FBAV|Twitter|LinkedInApp|Snapchat|musical_ly|BytedanceWebview|Line\//;

export function wantsAppPrompt(userAgent: string): boolean {
  return /iPhone|iPod/.test(userAgent) && NON_SAFARI.test(userAgent);
}

export function AppPrompt() {
  const [visible, setVisible] = useState(false);
  // covers the whole site header so no sliver of it shows underneath
  const [headerHeight, setHeaderHeight] = useState<number>();

  useEffect(() => {
    if (!wantsAppPrompt(navigator.userAgent)) return;
    const timer = window.setTimeout(() => {
      setHeaderHeight(document.querySelector("header")?.getBoundingClientRect().bottom);
      setVisible(true);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <aside
      aria-label="MineBench for iPhone"
      className="mb-app-prompt fixed inset-x-0 top-0 z-50 flex items-center border-b border-border bg-card px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-soft"
      style={{ minHeight: headerHeight }}
    >
      <div className="mx-auto flex w-full max-w-md items-center gap-3">
        <Image src="/icon-192.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-[10px] ring-1 ring-border" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">MineBench for iPhone</p>
          <p className="mt-0.5 text-xs leading-snug text-muted">Sign in with Apple, start a build anywhere, and get a ping when it’s done.</p>
        </div>
        <a href={APP_STORE_URL} className="mb-btn mb-btn-primary h-9 shrink-0 px-3 text-xs" onClick={() => setVisible(false)}>
          Get app
        </a>
        <button
          type="button"
          aria-label="Dismiss"
          className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          onClick={() => setVisible(false)}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
