import { LeaderboardSkeleton } from "@/components/leaderboard/LeaderboardSkeleton";

export default function LeaderboardLoading() {
  return (
    <div className="mb-page-fixed h-full min-h-0">
      <LeaderboardSkeleton />
    </div>
  );
}
