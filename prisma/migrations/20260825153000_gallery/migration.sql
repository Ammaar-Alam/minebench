ALTER TYPE "CustomBuildArtifactKind" ADD VALUE IF NOT EXISTS 'preview_mbv4';
ALTER TYPE "CustomBuildArtifactKind" ADD VALUE IF NOT EXISTS 'viewer_mbv4';
ALTER TYPE "CustomBuildArtifactKind" ADD VALUE IF NOT EXISTS 'viewer_mbf1';
ALTER TYPE "CustomBuildArtifactKind" ADD VALUE IF NOT EXISTS 'preview_svg';

CREATE TYPE "GalleryModerationKind" AS ENUM ('REPORT', 'FILTER_REJECTION', 'APPEAL', 'ADMIN_ACTION');
CREATE TYPE "GalleryModerationTarget" AS ENUM ('CANDIDATE', 'EXAMPLE', 'ACCOUNT', 'VOTE_BLOCK');
CREATE TYPE "GalleryReportReason" AS ENUM ('OFFENSIVE', 'SPAM', 'MISLEADING', 'OTHER');

ALTER TABLE "User"
  ADD COLUMN "publicNickname" VARCHAR(40),
  ADD COLUMN "publicNicknameNormalized" VARCHAR(40),
  ADD COLUMN "gallerySuspendedAt" TIMESTAMP(3),
  ADD COLUMN "gallerySuspensionReason" VARCHAR(240),
  ADD COLUMN "gallerySuspendedById" UUID,
  ADD COLUMN "galleryRestoredAt" TIMESTAMP(3);

-- Legacy draft rows remain readable for cleanup, while the NOT VALID check
-- requires ownership for every new saved generation without a destructive backfill
ALTER TABLE "CustomBuild"
  ADD COLUMN "ownerId" UUID,
  ADD COLUMN "removedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAt" TIMESTAMP(3),
  ADD COLUMN "objectsDeletedAt" TIMESTAMP(3),
  ADD COLUMN "deletionPendingAt" TIMESTAMP(3),
  ADD COLUMN "deletionError" TEXT,
  ADD COLUMN "storedByteSize" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "CustomBuild_owner_required" CHECK ("ownerId" IS NOT NULL) NOT VALID;

ALTER TABLE "CustomBuildSecret"
  ADD COLUMN "endpointCiphertext" TEXT,
  ADD COLUMN "endpointIv" TEXT,
  ADD COLUMN "endpointAuthTag" TEXT;

ALTER TABLE "CustomBuildArtifact" ADD COLUMN "storedByteSize" INTEGER NOT NULL DEFAULT 0;
UPDATE "CustomBuildArtifact"
SET "storedByteSize" = COALESCE("compressedByteSize", "byteSize");
ALTER TABLE "CustomBuildArtifact" ALTER COLUMN "storedByteSize" DROP DEFAULT;
UPDATE "CustomBuild" AS build
SET "storedByteSize" = artifact."storedByteSize"
FROM (
  SELECT "customBuildId", COALESCE(SUM("storedByteSize"), 0)::INTEGER AS "storedByteSize"
  FROM "CustomBuildArtifact"
  GROUP BY "customBuildId"
) AS artifact
WHERE artifact."customBuildId" = build."id";

CREATE TABLE "GalleryCandidate" (
  "id" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "promptText" TEXT NOT NULL,
  "promptKey" TEXT NOT NULL,
  "uploaderId" UUID NOT NULL,
  "postAnonymously" BOOLEAN NOT NULL DEFAULT false,
  "upvoteCount" INTEGER NOT NULL DEFAULT 0,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "selectedAt" TIMESTAMP(3),
  "selectedById" UUID,
  "officialPromptId" TEXT,
  "removedAt" TIMESTAMP(3),
  "adminHiddenAt" TIMESTAMP(3),
  "purgeAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GalleryCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GalleryCandidate_upvoteCount_check" CHECK ("upvoteCount" >= 0)
);

CREATE TABLE "GalleryExample" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "customBuildId" TEXT NOT NULL,
  "contributorId" UUID NOT NULL,
  "postAnonymously" BOOLEAN NOT NULL DEFAULT false,
  "removedAt" TIMESTAMP(3),
  "adminHiddenAt" TIMESTAMP(3),
  "purgeAt" TIMESTAMP(3),
  "previewRetained" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GalleryExample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GalleryVote" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GalleryVote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GalleryModerationRecord" (
  "id" TEXT NOT NULL,
  "kind" "GalleryModerationKind" NOT NULL,
  "target" "GalleryModerationTarget" NOT NULL,
  "action" TEXT,
  "reportReason" "GalleryReportReason",
  "note" TEXT,
  "safeSnapshot" JSONB,
  "actorUserId" UUID,
  "subjectUserId" UUID,
  "candidateId" TEXT,
  "exampleId" TEXT,
  "sessionHash" TEXT,
  "ipHmac" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purgeAt" TIMESTAMP(3),

  CONSTRAINT "GalleryModerationRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GalleryVoteBlock" (
  "id" TEXT NOT NULL,
  "userId" UUID,
  "sessionHash" TEXT,
  "ipHmac" TEXT,
  "createdById" UUID NOT NULL,
  "reversedById" UUID,
  "internalNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt" TIMESTAMP(3),

  CONSTRAINT "GalleryVoteBlock_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GalleryVoteBlock_identity_check" CHECK (
    "userId" IS NOT NULL OR "sessionHash" IS NOT NULL OR "ipHmac" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "User_publicNicknameNormalized_key" ON "User"("publicNicknameNormalized");
CREATE INDEX "User_gallerySuspendedById_idx" ON "User"("gallerySuspendedById");
CREATE INDEX "CustomBuild_ownerId_removedAt_status_createdAt_idx"
  ON "CustomBuild"("ownerId", "removedAt", "status", "createdAt");
CREATE INDEX "CustomBuild_ownerId_deletionPendingAt_idx"
  ON "CustomBuild"("ownerId", "deletionPendingAt");

CREATE UNIQUE INDEX "GalleryCandidate_publicId_key" ON "GalleryCandidate"("publicId");
CREATE UNIQUE INDEX "GalleryCandidate_promptKey_key" ON "GalleryCandidate"("promptKey");
CREATE UNIQUE INDEX "GalleryCandidate_officialPromptId_key" ON "GalleryCandidate"("officialPromptId");
CREATE INDEX "GalleryCandidate_adminHiddenAt_removedAt_upvoteCount_publis_idx"
  ON "GalleryCandidate"("adminHiddenAt", "removedAt", "upvoteCount", "publishedAt", "id");
CREATE INDEX "GalleryCandidate_adminHiddenAt_removedAt_publishedAt_id_idx"
  ON "GalleryCandidate"("adminHiddenAt", "removedAt", "publishedAt", "id");
CREATE INDEX "GalleryCandidate_uploaderId_removedAt_publishedAt_idx"
  ON "GalleryCandidate"("uploaderId", "removedAt", "publishedAt");
CREATE INDEX "GalleryCandidate_selectedById_idx" ON "GalleryCandidate"("selectedById");

CREATE UNIQUE INDEX "GalleryExample_candidateId_customBuildId_key"
  ON "GalleryExample"("candidateId", "customBuildId");
CREATE INDEX "GalleryExample_candidateId_adminHiddenAt_removedAt_createdA_idx"
  ON "GalleryExample"("candidateId", "adminHiddenAt", "removedAt", "createdAt");
CREATE INDEX "GalleryExample_contributorId_removedAt_createdAt_idx"
  ON "GalleryExample"("contributorId", "removedAt", "createdAt");
CREATE INDEX "GalleryExample_customBuildId_idx" ON "GalleryExample"("customBuildId");

CREATE UNIQUE INDEX "GalleryVote_candidateId_sessionId_key" ON "GalleryVote"("candidateId", "sessionId");
CREATE UNIQUE INDEX "GalleryVote_candidateId_userId_key" ON "GalleryVote"("candidateId", "userId");
CREATE INDEX "GalleryVote_sessionId_idx" ON "GalleryVote"("sessionId");
CREATE INDEX "GalleryVote_userId_createdAt_idx" ON "GalleryVote"("userId", "createdAt");

CREATE INDEX "GalleryModerationRecord_kind_createdAt_idx"
  ON "GalleryModerationRecord"("kind", "createdAt");
CREATE INDEX "GalleryModerationRecord_purgeAt_createdAt_idx"
  ON "GalleryModerationRecord"("purgeAt", "createdAt");
CREATE INDEX "GalleryModerationRecord_candidateId_idx" ON "GalleryModerationRecord"("candidateId");
CREATE INDEX "GalleryModerationRecord_exampleId_idx" ON "GalleryModerationRecord"("exampleId");
CREATE INDEX "GalleryModerationRecord_actorUserId_idx" ON "GalleryModerationRecord"("actorUserId");
CREATE INDEX "GalleryModerationRecord_subjectUserId_idx" ON "GalleryModerationRecord"("subjectUserId");

CREATE INDEX "GalleryVoteBlock_userId_reversedAt_idx" ON "GalleryVoteBlock"("userId", "reversedAt");
CREATE INDEX "GalleryVoteBlock_sessionHash_reversedAt_idx" ON "GalleryVoteBlock"("sessionHash", "reversedAt");
CREATE INDEX "GalleryVoteBlock_ipHmac_reversedAt_idx" ON "GalleryVoteBlock"("ipHmac", "reversedAt");
CREATE INDEX "GalleryVoteBlock_createdById_createdAt_idx" ON "GalleryVoteBlock"("createdById", "createdAt");
CREATE INDEX "GalleryVoteBlock_reversedById_idx" ON "GalleryVoteBlock"("reversedById");

ALTER TABLE "User"
  ADD CONSTRAINT "User_gallerySuspendedById_fkey"
  FOREIGN KEY ("gallerySuspendedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomBuild"
  ADD CONSTRAINT "CustomBuild_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GalleryCandidate"
  ADD CONSTRAINT "GalleryCandidate_uploaderId_fkey"
  FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GalleryCandidate"
  ADD CONSTRAINT "GalleryCandidate_selectedById_fkey"
  FOREIGN KEY ("selectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryCandidate"
  ADD CONSTRAINT "GalleryCandidate_officialPromptId_fkey"
  FOREIGN KEY ("officialPromptId") REFERENCES "Prompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryExample"
  ADD CONSTRAINT "GalleryExample_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "GalleryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GalleryExample"
  ADD CONSTRAINT "GalleryExample_customBuildId_fkey"
  FOREIGN KEY ("customBuildId") REFERENCES "CustomBuild"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GalleryExample"
  ADD CONSTRAINT "GalleryExample_contributorId_fkey"
  FOREIGN KEY ("contributorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GalleryVote"
  ADD CONSTRAINT "GalleryVote_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "GalleryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GalleryVote"
  ADD CONSTRAINT "GalleryVote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryModerationRecord"
  ADD CONSTRAINT "GalleryModerationRecord_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryModerationRecord"
  ADD CONSTRAINT "GalleryModerationRecord_subjectUserId_fkey"
  FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryModerationRecord"
  ADD CONSTRAINT "GalleryModerationRecord_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "GalleryCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryModerationRecord"
  ADD CONSTRAINT "GalleryModerationRecord_exampleId_fkey"
  FOREIGN KEY ("exampleId") REFERENCES "GalleryExample"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryVoteBlock"
  ADD CONSTRAINT "GalleryVoteBlock_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GalleryVoteBlock"
  ADD CONSTRAINT "GalleryVoteBlock_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GalleryVoteBlock"
  ADD CONSTRAINT "GalleryVoteBlock_reversedById_fkey"
  FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomBuild" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomBuildSecret" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomBuildJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomBuildArtifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomBuildEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomBuildStatsDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GalleryCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GalleryExample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GalleryVote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GalleryModerationRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GalleryVoteBlock" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "CustomBuild", "CustomBuildSecret", "CustomBuildJob",
      "CustomBuildArtifact", "CustomBuildEvent", "CustomBuildStatsDaily",
      "GalleryCandidate", "GalleryExample", "GalleryVote",
      "GalleryModerationRecord", "GalleryVoteBlock" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "CustomBuild", "CustomBuildSecret", "CustomBuildJob",
      "CustomBuildArtifact", "CustomBuildEvent", "CustomBuildStatsDaily",
      "GalleryCandidate", "GalleryExample", "GalleryVote",
      "GalleryModerationRecord", "GalleryVoteBlock" FROM authenticated;
  END IF;
END $$;
