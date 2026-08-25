-- Authenticated ownership is optional so public Arena voting remains anonymous by default.
ALTER TABLE "Vote" ADD COLUMN "userId" UUID;

CREATE INDEX "Vote_userId_createdAt_idx" ON "Vote"("userId", "createdAt");

ALTER TABLE "Vote"
  ADD CONSTRAINT "Vote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
