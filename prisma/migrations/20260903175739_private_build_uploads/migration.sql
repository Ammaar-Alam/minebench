ALTER TABLE "StealthGenerationResult"
  ADD COLUMN "uploadBucket" TEXT,
  ADD COLUMN "uploadPath" TEXT,
  ADD COLUMN "uploadExpiresAt" TIMESTAMP(3),
  ADD COLUMN "uploadQueuedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "StealthGenerationResult_uploadPath_key"
  ON "StealthGenerationResult"("uploadPath");

CREATE INDEX "StealthGenerationResult_uploadExpiresAt_idx"
  ON "StealthGenerationResult"("uploadExpiresAt");
