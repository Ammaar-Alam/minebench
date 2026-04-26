CREATE TABLE "ArenaShownJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "modelId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ArenaShownJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArenaShownJob_count_positive" CHECK ("count" > 0)
);

CREATE INDEX "ArenaShownJob_createdAt_pending_idx"
ON "ArenaShownJob" ("createdAt")
WHERE "processedAt" IS NULL;

CREATE INDEX "ArenaShownJob_modelId_idx" ON "ArenaShownJob"("modelId");

ALTER TABLE "ArenaShownJob"
ADD CONSTRAINT "ArenaShownJob_modelId_fkey"
FOREIGN KEY ("modelId") REFERENCES "Model"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
