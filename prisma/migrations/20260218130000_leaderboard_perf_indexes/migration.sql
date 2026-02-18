-- CreateIndex
CREATE INDEX "Matchup_modelAId_idx" ON "Matchup"("modelAId");

-- CreateIndex
CREATE INDEX "Matchup_modelBId_idx" ON "Matchup"("modelBId");

-- CreateIndex
CREATE INDEX "Vote_createdAt_idx" ON "Vote"("createdAt");

-- CreateIndex
CREATE INDEX "Vote_matchupId_createdAt_idx" ON "Vote"("matchupId", "createdAt");
