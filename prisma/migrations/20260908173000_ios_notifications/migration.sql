-- CreateEnum
CREATE TYPE "PushEnvironment" AS ENUM ('development', 'production');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('generation_succeeded', 'generation_failed', 'gallery_upvotes', 'gallery_contribution');

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" UUID NOT NULL,
    "generations" BOOLEAN NOT NULL DEFAULT true,
    "upvotes" BOOLEAN NOT NULL DEFAULT true,
    "contributions" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "environment" "PushEnvironment" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDelivery" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "exampleId" TEXT,
    "windowStart" TIMESTAMP(3),
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushDevice_userId_idx" ON "PushDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_token_environment_key" ON "PushDevice"("token", "environment");

-- CreateIndex
CREATE INDEX "PushDelivery_userId_idx" ON "PushDelivery"("userId");

-- CreateIndex
CREATE INDEX "PushDelivery_finishedAt_runAfter_idx" ON "PushDelivery"("finishedAt", "runAfter");

-- CreateIndex
CREATE INDEX "PushDelivery_createdAt_idx" ON "PushDelivery"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushDelivery_deviceId_eventKey_key" ON "PushDelivery"("deviceId", "eventKey");

-- CreateIndex
CREATE INDEX "GalleryVote_candidateId_createdAt_idx" ON "GalleryVote"("candidateId", "createdAt");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PushDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushDelivery" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "NotificationPreference", "PushDevice", "PushDelivery" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "NotificationPreference", "PushDevice", "PushDelivery" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "NotificationPreference", "PushDevice", "PushDelivery" FROM authenticated;
  END IF;
END $$;
