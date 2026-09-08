export default function GalleryDetailLoading() {
  return (
    <article aria-busy="true" aria-label="Loading gallery prompt" className="mx-auto w-full max-w-7xl py-4 sm:py-8">
      <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
        <div className="flex h-11 items-center justify-between gap-4">
          <div className="h-4 w-20 rounded bg-border/30" />
          <div className="h-11 w-[5.5rem] rounded-md border border-border/70 bg-card/10" />
        </div>
        <div className="mt-6 max-w-4xl sm:mt-8">
          <div className="h-4 w-32 rounded bg-border/30" />
          <div className="mt-3 h-10 w-4/5 rounded bg-border/45 sm:h-12" />
          <div className="mt-6 flex gap-2">
            <div className="h-11 w-16 rounded-md bg-border/30" />
            <div className="h-11 w-28 rounded-md bg-border/30" />
          </div>
        </div>
        <div className="mt-8 grid gap-6 sm:mt-10 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <div className="overflow-hidden rounded-md border border-border/70">
            <div className="flex h-16 items-center px-4"><div className="h-4 w-36 rounded bg-border/30" /></div>
            <div className="h-[300px] bg-card/25 sm:h-[360px] md:h-[420px] lg:h-[480px] xl:h-[520px]" />
          </div>
          <div className="min-w-0">
            <div className="flex h-9 items-center"><div className="h-3 w-20 rounded bg-border/30" /></div>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-1">
              {[0, 1].map((index) => (
                <div key={index} className="overflow-hidden rounded-md border border-border/70">
                  <div className="aspect-video bg-card/25" />
                  <div className="space-y-2 p-3">
                    <div className="h-4 w-3/4 rounded bg-border/30" />
                    <div className="h-3 w-1/2 rounded bg-border/25" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
