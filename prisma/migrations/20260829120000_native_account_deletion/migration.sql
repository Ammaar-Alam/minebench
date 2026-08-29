ALTER TABLE "User"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "authDeletedAt" TIMESTAMP(3);

CREATE INDEX "User_deletedAt_authDeletedAt_idx"
  ON "User"("deletedAt", "authDeletedAt");
