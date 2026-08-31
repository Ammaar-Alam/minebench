import Link from "next/link";
import { GallerySkeletonGrid } from "@/components/gallery/GalleryExplore";

export default function GalleryLoading() {
  return (
    <div className="mb-fade-in mx-auto w-full max-w-7xl py-4 sm:py-8">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Gallery</h1>
          <p className="mt-2 max-w-md text-sm text-muted">
            Use a prompt, build it, share the result.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/account#builds" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-muted transition-colors hover:text-fg motion-reduce:transition-none">
            Builds
          </Link>
          <Link href="/sign-in?next=/gallery" className="mb-btn mb-btn-primary h-11">
            Sign in
          </Link>
        </div>
      </header>

      <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex items-center gap-7" aria-label="Gallery sorting">
          <span className="relative inline-flex min-h-11 items-center text-sm font-semibold capitalize text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg">
            Top
          </span>
          <span className="relative inline-flex min-h-11 items-center text-sm capitalize text-muted">
            New
          </span>
          <span className="relative inline-flex min-h-11 items-center text-sm capitalize text-muted">
            Official
          </span>
        </nav>

        <div className="relative w-full sm:w-80 lg:w-96">
          <span aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted">
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </span>
          <input
            type="search"
            disabled
            placeholder="Search prompts or models…"
            aria-label="Search prompts or models"
            className="mb-field h-11 w-full pl-9 pr-11 text-sm placeholder:text-muted/60"
          />
          <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden rounded border border-border/70 bg-card/40 px-1.5 py-0.5 font-mono text-[10px] text-muted sm:inline-block">
            /
          </span>
        </div>
      </div>

      <GallerySkeletonGrid count={8} />
    </div>
  );
}
