import Link from "next/link";

const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/ammaaralam";
const GITHUB_REPO_URL = "https://github.com/Ammaar-Alam/minebench";
const PRIVACY_POLICY_URL = "https://github.com/Ammaar-Alam/minebench/blob/master/docs/privacy-policy.md";

export function SiteFooter() {
  return (
    <footer
      id="mb-footer"
      className="border-t border-border/60 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-xs text-muted sm:py-3.5"
    >
      <div className="flex flex-col gap-2.5 sm:gap-2">
        {/* Primary Row: Brand, Tagline, and Navigation */}
        <div className="flex flex-col gap-y-2 sm:flex-row sm:items-center sm:justify-between sm:gap-x-4">
          <div className="flex items-center gap-x-2">
            <span className="font-medium text-fg">MineBench</span>
            <span className="text-border" aria-hidden="true">·</span>
            <span>AI spatial reasoning benchmark</span>
          </div>

          <nav
            aria-label="Footer navigation"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:gap-x-5"
          >
            <Link
              href="/contact"
              className="rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Contact
            </Link>
            <Link
              href="/private-evaluations"
              className="rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Private Evaluations
            </Link>
            <a
              href={BUY_ME_A_COFFEE_URL}
              target="_blank"
              rel="noreferrer"
              title="Help fund MineBench benchmark runs"
              className="rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Support
            </a>
            <a
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Privacy
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              GitHub
            </a>
          </nav>
        </div>

        {/* Secondary Row: Attributions */}
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted/75">
          <span>
            Textures{" "}
            <a
              href="https://faithfulpack.net/"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm underline decoration-border/60 underline-offset-2 transition-colors hover:text-fg hover:decoration-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Faithful
            </a>
          </span>
          <span className="text-border/70" aria-hidden="true">·</span>
          <span>
            Inspired by{" "}
            <a
              href="https://github.com/mc-bench"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm underline decoration-border/60 underline-offset-2 transition-colors hover:text-fg hover:decoration-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              MC-Bench
            </a>
            {" "}and{" "}
            <a
              href="https://voxelbench.ai/"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm underline decoration-border/60 underline-offset-2 transition-colors hover:text-fg hover:decoration-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              VoxelBench
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
