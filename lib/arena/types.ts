import type { VoxelBuild } from "@/lib/voxel/types";

export type VoteChoice = "A" | "B" | "TIE" | "BOTH_BAD";

export type ArenaMatchup = {
  id: string;
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
    eloRating: number;
    shownCount: number;
    winCount: number;
    lossCount: number;
    drawCount: number;
    bothBadCount: number;
  }[];
};

