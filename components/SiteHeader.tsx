import Link from "next/link";

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      className="rounded-md px-3 py-2 text-sm text-muted transition hover:bg-card hover:text-fg"
      href={href}
    >
      {label}
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 -mx-4 border-b border-border bg-bg/80 px-4 py-4 backdrop-blur">
      <div className="flex items-center justify-between">
        <Link className="flex items-center gap-2" href="/">
          <div className="h-8 w-8 rounded-lg bg-accent/20 ring-1 ring-accent/30" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">MineBench</div>
            <div className="text-xs text-muted">Arena + Sandbox</div>
          </div>
        </Link>

        <nav className="flex items-center gap-1">
          <NavLink href="/" label="Arena" />
          <NavLink href="/sandbox" label="Sandbox" />
          <NavLink href="/leaderboard" label="Leaderboard" />
        </nav>
      </div>
    </header>
  );
}
