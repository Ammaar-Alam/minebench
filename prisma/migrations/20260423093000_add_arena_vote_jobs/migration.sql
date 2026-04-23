CREATE TABLE "ArenaVoteJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "voteId" TEXT NOT NULL,
    "matchupId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "modelAId" TEXT NOT NULL,
    "modelBId" TEXT NOT NULL,
    "choice" TEXT NOT NULL,

    CONSTRAINT "ArenaVoteJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArenaVoteJob_voteId_key" ON "ArenaVoteJob"("voteId");
CREATE INDEX "ArenaVoteJob_createdAt_pending_idx"
ON "ArenaVoteJob" ("createdAt")
WHERE "processedAt" IS NULL;
CREATE INDEX "ArenaVoteJob_matchupId_idx" ON "ArenaVoteJob"("matchupId");

ALTER TABLE "ArenaVoteJob"
ADD CONSTRAINT "ArenaVoteJob_voteId_fkey"
FOREIGN KEY ("voteId") REFERENCES "Vote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
