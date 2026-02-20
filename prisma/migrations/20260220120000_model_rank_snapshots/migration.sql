CREATE TABLE "ModelRankSnapshot" (
  "id" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "rank" INTEGER NOT NULL,
  "rankScore" DOUBLE PRECISION NOT NULL,
  "confidence" INTEGER NOT NULL,
  "modelId" TEXT NOT NULL,
  CONSTRAINT "ModelRankSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ModelRankSnapshot_capturedAt_modelId_key"
  ON "ModelRankSnapshot"("capturedAt", "modelId");

CREATE INDEX "ModelRankSnapshot_capturedAt_idx"
  ON "ModelRankSnapshot"("capturedAt");

CREATE INDEX "ModelRankSnapshot_capturedAt_rank_idx"
  ON "ModelRankSnapshot"("capturedAt", "rank");

CREATE INDEX "ModelRankSnapshot_modelId_idx"
  ON "ModelRankSnapshot"("modelId");

ALTER TABLE "ModelRankSnapshot"
  ADD CONSTRAINT "ModelRankSnapshot_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "Model"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
