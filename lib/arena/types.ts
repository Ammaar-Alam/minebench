import type { VoxelBuild } from "@/lib/voxel/types";

export type VoteChoice = "A" | "B" | "TIE" | "BOTH_BAD";

export type ArenaMatchup = {
  id: string;
  samplingLane?: "coverage" | "contender" | "uncertainty" | "exploration";
  prompt: { id: string; text: string };
  a: {
    model: { key: string; provider: string; displayName: string; eloRating: number };
    build: VoxelBuild;
  };
  b: {
    model: { key: string; provider: string; displayName: string; eloRating: number };
    build: VoxelBuild;
  };
};

export type PromptListResponse = {
  prompts: { id: string; text: string }[];
};

export type LeaderboardResponse = {
  models: {
    key: string;
    provider: string;
    displayName: string;
    stability: "Provisional" | "Established" | "Stable";
    eloRating: number;
    ratingDeviation: number;
    rankScore: number;
    confidence: number;
    shownCount: number;
    winCount: number;
    lossCount: number;
    drawCount: number;
    bothBadCount: number;
    coveredPrompts: number;
    activePrompts: number;
    promptCoverage: number;
    pairCoverageScore: number | null;
    qualityFloorScore: number | null;
    meanScore: number | null;
    scoreVariance: number | null;
    scoreSpread: number | null;
    consistency: number | null;
    sampledPrompts: number;
    sampledVotes: number;
  }[];
};
