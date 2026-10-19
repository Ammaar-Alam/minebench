CREATE TABLE "ArenaVoteReviewKeep" (
  "person" TEXT NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArenaVoteReviewKeep_pkey" PRIMARY KEY ("person")
);

CREATE INDEX "ArenaVoteReviewKeep_createdById_idx" ON "ArenaVoteReviewKeep"("createdById");

ALTER TABLE "ArenaVoteReviewKeep"
  ADD CONSTRAINT "ArenaVoteReviewKeep_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
