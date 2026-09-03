ALTER TABLE "StealthGenerationResult"
ADD COLUMN "workerAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lockedBy" TEXT,
ADD COLUMN "lockedAt" TIMESTAMP(3),
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "StealthGenerationResult_status_runAfter_createdAt_idx"
ON "StealthGenerationResult"("status", "runAfter", "createdAt");

CREATE INDEX "StealthGenerationResult_leaseExpiresAt_idx"
ON "StealthGenerationResult"("leaseExpiresAt");
