export function SiteFooter() {
  return (
    <footer className="border-t border-border py-6 text-sm text-muted">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>MineBench</div>
        <div className="flex flex-col gap-1 md:items-end">
          <div>
            Textures: Faithful pack (see{" "}
            <span className="font-mono">faithful-32x-1.21.11/LICENSE.txt</span>)
          </div>
        </div>
      </div>
    </footer>
  );
}
