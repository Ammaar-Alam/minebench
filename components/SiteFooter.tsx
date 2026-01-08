export function SiteFooter() {
  return (
    <footer className="border-t border-border py-6 text-sm text-muted">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>MineBench</div>
        <div className="flex flex-col gap-1 md:items-end">
          <div>
            Textures:{" "}
            <a
              className="text-fg underline decoration-border underline-offset-4 hover:decoration-fg"
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
    </footer>
  );
}
