export default function ModelDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-3.5 pb-10 sm:space-y-4 sm:pb-14">
      <section className="mb-panel overflow-hidden p-4 sm:p-5">
        <div className="mb-panel-inner space-y-3.5">
          <div className="h-5 w-28 animate-pulse rounded-full bg-border/70" />
          <div className="h-12 w-3/4 animate-pulse rounded-xl bg-border/55 sm:h-16" />
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="h-16 animate-pulse rounded-xl bg-border/45" />
            <div className="h-16 animate-pulse rounded-xl bg-border/45" />
            <div className="h-16 animate-pulse rounded-xl bg-border/45" />
            <div className="h-16 animate-pulse rounded-xl bg-border/45" />
          </div>
        </div>
      </section>

      <section className="mb-panel overflow-hidden p-4 sm:p-5">
        <div className="mb-panel-inner space-y-3">
          <div className="h-4 w-40 animate-pulse rounded bg-border/60" />
          <div className="h-64 animate-pulse rounded-2xl bg-border/45" />
        </div>
      </section>

      <section className="mb-panel overflow-hidden p-4 sm:p-5">
        <div className="mb-panel-inner space-y-3">
          <div className="h-4 w-44 animate-pulse rounded bg-border/60" />
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="h-56 animate-pulse rounded-2xl bg-border/45"
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
