ALTER TABLE "Model"
  ADD COLUMN "glickoRd" DOUBLE PRECISION NOT NULL DEFAULT 350,
  ADD COLUMN "glickoVolatility" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
  ADD COLUMN "conservativeRating" DOUBLE PRECISION NOT NULL DEFAULT 800;

UPDATE "Model"
SET "conservativeRating" = "eloRating" - (2 * "glickoRd");

UPDATE "Model"
SET "lossCount" = GREATEST("lossCount" - "bothBadCount", 0);

CREATE INDEX "Model_conservativeRating_idx" ON "Model"("conservativeRating");

ALTER TABLE "Matchup"
  ADD COLUMN "samplingLane" TEXT,
  ADD COLUMN "samplingReason" TEXT;

CREATE INDEX "Matchup_samplingLane_createdAt_idx" ON "Matchup"("samplingLane", "createdAt");
