ALTER TABLE "PublicSessionActivity"
  ADD COLUMN "ipHmac" TEXT;

CREATE INDEX "PublicSessionActivity_ipHmac_lastSeenAt_idx"
  ON "PublicSessionActivity"("ipHmac", "lastSeenAt");
