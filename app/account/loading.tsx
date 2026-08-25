import { PersonalRankingSkeleton } from "./PersonalRanking";

export default function AccountLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl animate-pulse space-y-10 py-8 motion-reduce:animate-none">
      <div className="space-y-3">
        <div className="h-3 w-32 rounded-sm bg-border/50" />
        <div className="h-12 w-72 max-w-full rounded-sm bg-border/50" />
        <div className="h-4 w-48 rounded-sm bg-border/40" />
      </div>
      <PersonalRankingSkeleton />
      <div className="grid gap-7 border-t border-border pt-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-3">
          <div className="h-3 w-20 rounded-sm bg-border/40" />
          <div className="h-6 w-28 rounded-sm bg-border/50" />
          <div className="h-12 w-full max-w-lg rounded-sm bg-border/35" />
        </div>
        <div className="h-20 rounded-md bg-border/30" />
      </div>
    </div>
  );
}
