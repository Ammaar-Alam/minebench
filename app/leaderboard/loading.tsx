import { LeaderboardPageShell } from "@/components/leaderboard/LeaderboardPageShell";
import { LeaderboardSkeleton } from "@/components/leaderboard/LeaderboardSkeleton";

export default function LeaderboardLoading() {
  return (
    <LeaderboardPageShell>
      <div className="h-full min-h-0">
        <LeaderboardSkeleton />
      </div>
    </LeaderboardPageShell>
  );
}
