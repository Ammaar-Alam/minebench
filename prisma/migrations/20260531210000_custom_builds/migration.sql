-- CreateEnum
CREATE TYPE "CustomBuildStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "CustomBuildJobType" AS ENUM ('generate', 'export');

-- CreateEnum
CREATE TYPE "CustomBuildJobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "CustomBuildArtifactKind" AS ENUM ('build_json', 'preview_json', 'raw_text_debug', 'glb', 'stl', 'schem');

-- CreateEnum
CREATE TYPE "CustomBuildStorageEncoding" AS ENUM ('identity', 'gzip');

-- CreateTable
CREATE TABLE "CustomBuild" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "CustomBuildStatus" NOT NULL DEFAULT 'queued',
    "currentStage" TEXT,
    "progress" JSONB,
    "promptText" TEXT NOT NULL,
    "promptSha256" TEXT NOT NULL,
    "gridSize" INTEGER NOT NULL,
    "palette" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'precise',
    "generationMode" TEXT NOT NULL DEFAULT 'tool',
    "modelKind" TEXT NOT NULL,
    "modelKey" TEXT,
    "modelProvider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelDisplayName" TEXT NOT NULL,
    "openRouterModelId" TEXT,
    "customBaseUrl" TEXT,
    "preferOpenRouter" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT,
    "blockCount" INTEGER,
    "generationTimeMs" INTEGER,
    "warnings" JSONB,
    "metrics" JSONB,
    "buildSha256" TEXT,
    "buildByteSize" INTEGER,
    "buildCompressedByteSize" INTEGER,
    "previewBlockCount" INTEGER,
    "previewSha256" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "requestedIpHash" TEXT,
    "requestedUserAgentHash" TEXT,

    CONSTRAINT "CustomBuild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomBuildSecret" (
    "id" TEXT NOT NULL,
    "customBuildId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyCiphertext" TEXT NOT NULL,
    "keyIv" TEXT NOT NULL,
    "keyAuthTag" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomBuildSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomBuildJob" (
    "id" TEXT NOT NULL,
    "customBuildId" TEXT NOT NULL,
    "type" "CustomBuildJobType" NOT NULL,
    "status" "CustomBuildJobStatus" NOT NULL DEFAULT 'queued',
    "payload" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomBuildJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomBuildArtifact" (
    "id" TEXT NOT NULL,
    "customBuildId" TEXT NOT NULL,
    "kind" "CustomBuildArtifactKind" NOT NULL,
    "format" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "encoding" "CustomBuildStorageEncoding" NOT NULL DEFAULT 'identity',
    "contentType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sourceBuildSha256" TEXT,
    "byteSize" INTEGER NOT NULL,
    "compressedByteSize" INTEGER,
    "blockCount" INTEGER,
    "exportStats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomBuildArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomBuildEvent" (
    "id" TEXT NOT NULL,
    "customBuildId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomBuildEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomBuildStatsDaily" (
    "day" TIMESTAMP(3) NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "canceled" INTEGER NOT NULL DEFAULT 0,
    "exportsRequested" INTEGER NOT NULL DEFAULT 0,
    "exportsSucceeded" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomBuildStatsDaily_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomBuild_publicId_key" ON "CustomBuild"("publicId");

-- CreateIndex
CREATE INDEX "CustomBuild_status_createdAt_idx" ON "CustomBuild"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CustomBuild_createdAt_idx" ON "CustomBuild"("createdAt");

-- CreateIndex
CREATE INDEX "CustomBuild_promptSha256_idx" ON "CustomBuild"("promptSha256");

-- CreateIndex
CREATE INDEX "CustomBuild_modelProvider_modelId_idx" ON "CustomBuild"("modelProvider", "modelId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomBuildSecret_customBuildId_key" ON "CustomBuildSecret"("customBuildId");

-- CreateIndex
CREATE INDEX "CustomBuildSecret_expiresAt_idx" ON "CustomBuildSecret"("expiresAt");

-- CreateIndex
CREATE INDEX "CustomBuildJob_status_runAfter_priority_createdAt_idx" ON "CustomBuildJob"("status", "runAfter", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "CustomBuildJob_leaseExpiresAt_idx" ON "CustomBuildJob"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CustomBuildJob_customBuildId_type_status_idx" ON "CustomBuildJob"("customBuildId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomBuildArtifact_customBuildId_kind_sourceBuildSha256_key" ON "CustomBuildArtifact"("customBuildId", "kind", "sourceBuildSha256");

-- CreateIndex
CREATE INDEX "CustomBuildArtifact_customBuildId_kind_idx" ON "CustomBuildArtifact"("customBuildId", "kind");

-- CreateIndex
CREATE INDEX "CustomBuildArtifact_sha256_idx" ON "CustomBuildArtifact"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "CustomBuildEvent_customBuildId_seq_key" ON "CustomBuildEvent"("customBuildId", "seq");

-- CreateIndex
CREATE INDEX "CustomBuildEvent_customBuildId_createdAt_idx" ON "CustomBuildEvent"("customBuildId", "createdAt");

-- AddForeignKey
ALTER TABLE "CustomBuildSecret" ADD CONSTRAINT "CustomBuildSecret_customBuildId_fkey" FOREIGN KEY ("customBuildId") REFERENCES "CustomBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomBuildJob" ADD CONSTRAINT "CustomBuildJob_customBuildId_fkey" FOREIGN KEY ("customBuildId") REFERENCES "CustomBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomBuildArtifact" ADD CONSTRAINT "CustomBuildArtifact_customBuildId_fkey" FOREIGN KEY ("customBuildId") REFERENCES "CustomBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomBuildEvent" ADD CONSTRAINT "CustomBuildEvent_customBuildId_fkey" FOREIGN KEY ("customBuildId") REFERENCES "CustomBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE;
