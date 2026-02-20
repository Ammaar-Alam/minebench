import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";

export type VoteChoice = "A" | "B" | "TIE" | "BOTH_BAD";

export type ArenaBuildVariant = "preview" | "full";

export type ArenaBuildRef = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
};

export type ArenaBuildLoadHints = {
  initialVariant: ArenaBuildVariant;
  fullBlockCount: number;
  previewBlockCount: number;
  previewStride: number;
  fullEstimatedBytes: number | null;
};

export type ArenaBuildStreamHelloEvent = {
  type: "hello";
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  serverValidated: boolean;
  buildLoadHints?: ArenaBuildLoadHints;
  totalBlocks: number;
  chunkCount: number;
  chunkBlockCount: number;
  estimatedBytes: number | null;
  source: "live" | "artifact";
  pad?: string;
};

export type ArenaBuildStreamChunkEvent = {
  type: "chunk";
  index: number;
  chunkCount: number;
  receivedBlocks: number;
  totalBlocks: number;
  blocks: VoxelBlock[];
};

export type ArenaBuildStreamCompleteEvent = {
  type: "complete";
  totalBlocks: number;
  durationMs: number;
};

export type ArenaBuildStreamErrorEvent = {
  type: "error";
  message: string;
};

export type ArenaBuildStreamPingEvent = {
  type: "ping";
  ts: number;
};

export type ArenaBuildStreamEvent =
  | ArenaBuildStreamHelloEvent
  | ArenaBuildStreamChunkEvent
  | ArenaBuildStreamCompleteEvent
  | ArenaBuildStreamErrorEvent
  | ArenaBuildStreamPingEvent;

export type ArenaMatchup = {
  id: string;
  samplingLane?: "coverage" | "contender" | "uncertainty" | "exploration";
  prompt: { id: string; text: string };
  a: {
    model: { key: string; provider: string; displayName: string; eloRating: number };
    build: VoxelBuild | null;
    buildRef?: ArenaBuildRef;
    previewRef?: ArenaBuildRef;
    serverValidated?: boolean;
    buildLoadHints?: ArenaBuildLoadHints;
  };
  b: {
    model: { key: string; provider: string; displayName: string; eloRating: number };
    build: VoxelBuild | null;
    buildRef?: ArenaBuildRef;
    previewRef?: ArenaBuildRef;
    serverValidated?: boolean;
    buildLoadHints?: ArenaBuildLoadHints;
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
    rank: number;
    rankDelta24h: number | null;
    hasBaseline24h: boolean;
    movementVisible: boolean;
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
