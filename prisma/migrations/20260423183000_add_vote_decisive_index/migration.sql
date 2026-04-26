-- Speeds coverage drift checks and rebuild joins over decisive arena votes.
CREATE INDEX "Vote_decisive_matchupId_idx"
ON "Vote"("matchupId")
WHERE "choice" IN ('A', 'B');
