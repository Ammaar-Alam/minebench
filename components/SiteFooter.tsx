export function SiteFooter() {
  return (
    <footer
      id="mb-footer"
      className="border-t border-border/60 py-2.5 text-xs text-muted"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span>
          <span className="font-medium text-fg">MineBench</span>
          <span className="mx-1.5 text-border">|</span>
          AI spatial reasoning benchmark
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Textures:{" "}
            <a
              className="text-fg underline decoration-border/70 underline-offset-2 hover:decoration-fg"
              href="https://faithfulpack.net/"
              target="_blank"
              rel="noreferrer"
            >
              Faithful Pack
            </a>
          </span>
          <span className="text-border">·</span>
          <span>
            Inspired by{" "}
            <a
              className="text-fg underline decoration-border/70 underline-offset-2 hover:decoration-fg"
              href="https://mcbench.ai/"
              target="_blank"
              rel="noreferrer"
            >
              MC-Bench
            </a>
          </span>
        </span>
      </div>
    </footer>
  );
}
