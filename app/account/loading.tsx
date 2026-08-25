export default function AccountLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl animate-pulse space-y-8 py-8 motion-reduce:animate-none">
      <div className="space-y-3 border-b border-border pb-7">
        <div className="h-3 w-32 rounded-sm bg-border/50" />
        <div className="h-12 w-72 max-w-full rounded-sm bg-border/50" />
        <div className="h-4 w-48 rounded-sm bg-border/40" />
      </div>
      <div className="grid gap-px border-y border-border bg-border sm:grid-cols-3">
        {[0, 1, 2].map((item) => <div key={item} className="h-24 bg-bg" />)}
      </div>
      <div className="h-80 rounded-md border border-border bg-card/30" />
    </div>
  );
}
