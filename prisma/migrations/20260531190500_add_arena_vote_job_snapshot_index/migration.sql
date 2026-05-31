CREATE INDEX "ArenaVoteJob_sampling_coverage_snapshot_idx"
ON "ArenaVoteJob" ("processedAt", "promptId", "modelAId", "modelBId")
INCLUDE ("id")
WHERE "choice" IN ('A', 'B');
