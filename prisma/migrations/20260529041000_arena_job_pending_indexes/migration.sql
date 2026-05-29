CREATE INDEX IF NOT EXISTS "ArenaVoteJob_processedAt_createdAt_idx"
  ON "ArenaVoteJob"("processedAt", "createdAt");

CREATE INDEX IF NOT EXISTS "ArenaShownJob_processedAt_createdAt_idx"
  ON "ArenaShownJob"("processedAt", "createdAt");
