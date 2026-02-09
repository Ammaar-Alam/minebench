import { Leaderboard } from "@/components/leaderboard/Leaderboard";
import { LeaderboardPageShell } from "@/components/leaderboard/LeaderboardPageShell";

export default function LeaderboardPage() {
  return (
    <LeaderboardPageShell>
      <div className="h-full min-h-0">
        <Leaderboard />
      </div>
    </LeaderboardPageShell>
  );
}
