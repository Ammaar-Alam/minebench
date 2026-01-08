export function SiteFooter() {
  return (
    <footer className="py-10 text-sm text-muted">
      <div className="mb-subpanel px-5 py-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-1">
            <div className="font-display text-sm font-semibold text-fg">MineBench</div>
            <div className="text-xs text-muted2">
              A benchmark for AI spatial reasoning via Minecraft-style voxel builds.
            </div>
          </div>
          <div className="flex flex-col gap-1 md:items-end">
            <div>
              Textures:{" "}
              <a
                className="text-fg underline decoration-border/70 underline-offset-4 hover:decoration-fg"
                href="https://faithfulpack.net/"
                target="_blank"
                rel="noreferrer"
              >
                Faithful Pack
              </a>{" "}
              (see <span className="font-mono">faithful-32x-1.21.11/LICENSE.txt</span>)
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
