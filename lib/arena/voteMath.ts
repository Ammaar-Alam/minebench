export type ArenaVoteCounts = {
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
};

export type ArenaVoteSummary = {
  decisiveLossCount: number;
  decisiveVotes: number;
  totalVotes: number;
};

export function summarizeArenaVotes(counts: ArenaVoteCounts): ArenaVoteSummary {
  const decisiveLossCount = Math.max(0, counts.lossCount);
  const decisiveVotes = counts.winCount + decisiveLossCount + counts.drawCount;
  const totalVotes = decisiveVotes + counts.bothBadCount;
  return { decisiveLossCount, decisiveVotes, totalVotes };
}
