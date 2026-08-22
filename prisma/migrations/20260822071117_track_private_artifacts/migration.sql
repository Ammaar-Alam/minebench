CREATE TABLE "StealthCohortUpload" (
  "id" UUID NOT NULL,
  "experimentId" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StealthCohortUpload_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArenaBuildArtifact" (
  "buildId" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArenaBuildArtifact_pkey" PRIMARY KEY ("buildId", "bucket", "path")
);

CREATE UNIQUE INDEX "StealthCohortUpload_bucket_path_key"
  ON "StealthCohortUpload"("bucket", "path");
CREATE INDEX "StealthCohortUpload_experimentId_expiresAt_idx"
  ON "StealthCohortUpload"("experimentId", "expiresAt");
CREATE INDEX "ArenaBuildArtifact_bucket_path_idx"
  ON "ArenaBuildArtifact"("bucket", "path");
CREATE INDEX "Vote_createdAt_id_idx" ON "Vote"("createdAt", "id");

ALTER TABLE "StealthCohortUpload"
  ADD CONSTRAINT "StealthCohortUpload_experimentId_fkey"
  FOREIGN KEY ("experimentId") REFERENCES "StealthExperiment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ArenaBuildArtifact"
  ADD CONSTRAINT "ArenaBuildArtifact_buildId_fkey"
  FOREIGN KEY ("buildId") REFERENCES "Build"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StealthCohortUpload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArenaBuildArtifact" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "StealthCohortUpload", "ArenaBuildArtifact" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "StealthCohortUpload", "ArenaBuildArtifact" FROM authenticated;
  END IF;
END $$;
