CREATE TABLE "PublicSessionActivity" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" UUID,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "city" VARCHAR(160),
  "countryRegion" VARCHAR(64),
  "country" VARCHAR(8),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PublicSessionActivity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicSessionActivity_sessionId_key"
  ON "PublicSessionActivity"("sessionId");
CREATE INDEX "PublicSessionActivity_lastSeenAt_idx"
  ON "PublicSessionActivity"("lastSeenAt");
CREATE INDEX "PublicSessionActivity_userId_lastSeenAt_idx"
  ON "PublicSessionActivity"("userId", "lastSeenAt");

ALTER TABLE "PublicSessionActivity"
  ADD CONSTRAINT "PublicSessionActivity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PublicSessionActivity" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "PublicSessionActivity" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "PublicSessionActivity" FROM authenticated;
  END IF;
END $$;
