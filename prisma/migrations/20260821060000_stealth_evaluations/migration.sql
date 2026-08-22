-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "StealthExportPolicy" AS ENUM ('AGGREGATES_ONLY', 'DEIDENTIFIED_VOTES');

-- CreateEnum
CREATE TYPE "StealthExperimentStatus" AS ENUM ('DRAFT', 'VALIDATING', 'GENERATING', 'READY', 'ACTIVE', 'PAUSED', 'STABLE', 'DEGRADED', 'WITHDRAWN', 'CLOSED', 'RELEASED');

-- CreateEnum
CREATE TYPE "StealthVariantStatus" AS ENUM ('DRAFT', 'VALIDATING', 'GENERATING', 'READY', 'ACTIVE', 'DEGRADED', 'WITHDRAWN', 'RELEASED');

-- CreateEnum
CREATE TYPE "StealthGenerationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "StealthGenerationResultStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "ArenaVoteJob" ADD COLUMN     "stealthVariantId" TEXT;

-- AlterTable
ALTER TABLE "Matchup" ADD COLUMN     "stealthVariantId" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "organizationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("organizationId","userId")
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "authUserId" UUID,
    "acceptedById" UUID,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StealthExperiment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StealthExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "exportPolicy" "StealthExportPolicy" NOT NULL DEFAULT 'AGGREGATES_ONLY',
    "targetDecisiveVotes" INTEGER NOT NULL DEFAULT 1000,
    "agreementReference" TEXT,
    "startsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "retentionDeleteAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StealthExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StealthVariant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "codename" TEXT NOT NULL,
    "status" "StealthVariantStatus" NOT NULL DEFAULT 'DRAFT',
    "modelId" TEXT NOT NULL,
    "releasedModelId" TEXT,
    "checkpointFingerprint" TEXT,
    "endpointEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastValidatedAt" TIMESTAMP(3),
    "cohortGeneratedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "expectedBuildCount" INTEGER NOT NULL DEFAULT 0,
    "generatedBuildCount" INTEGER NOT NULL DEFAULT 0,
    "generationFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastGenerationError" TEXT,
    "eloRating" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "glickoRd" DOUBLE PRECISION NOT NULL DEFAULT 350,
    "glickoVolatility" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    "conservativeRating" DOUBLE PRECISION NOT NULL DEFAULT 800,
    "shownCount" INTEGER NOT NULL DEFAULT 0,
    "winCount" INTEGER NOT NULL DEFAULT 0,
    "lossCount" INTEGER NOT NULL DEFAULT 0,
    "drawCount" INTEGER NOT NULL DEFAULT 0,
    "bothBadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StealthVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StealthEndpointCredential" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StealthEndpointCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StealthGenerationRun" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "status" "StealthGenerationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "promptCohortId" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "expectedBuildCount" INTEGER NOT NULL,
    "completedBuildCount" INTEGER NOT NULL DEFAULT 0,
    "failedBuildCount" INTEGER NOT NULL DEFAULT 0,
    "providerCallCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "StealthGenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StealthGenerationResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "buildId" TEXT,
    "status" "StealthGenerationResultStatus" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "generationTimeMs" INTEGER NOT NULL,
    "requestConfiguration" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StealthGenerationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_authUserId_idx" ON "OrganizationInvitation"("authUserId");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_acceptedById_idx" ON "OrganizationInvitation"("acceptedById");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_organizationId_email_key" ON "OrganizationInvitation"("organizationId", "email");

-- CreateIndex
CREATE INDEX "StealthExperiment_organizationId_status_idx" ON "StealthExperiment"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StealthExperiment_organizationId_slug_key" ON "StealthExperiment"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "StealthVariant_modelId_key" ON "StealthVariant"("modelId");

-- CreateIndex
CREATE INDEX "StealthVariant_experimentId_status_idx" ON "StealthVariant"("experimentId", "status");

-- CreateIndex
CREATE INDEX "StealthVariant_releasedModelId_idx" ON "StealthVariant"("releasedModelId");

-- CreateIndex
CREATE UNIQUE INDEX "StealthVariant_experimentId_codename_key" ON "StealthVariant"("experimentId", "codename");

-- CreateIndex
CREATE UNIQUE INDEX "StealthEndpointCredential_variantId_key" ON "StealthEndpointCredential"("variantId");

-- CreateIndex
CREATE INDEX "StealthGenerationRun_variantId_startedAt_idx" ON "StealthGenerationRun"("variantId", "startedAt");

-- CreateIndex
CREATE INDEX "StealthGenerationResult_promptId_idx" ON "StealthGenerationResult"("promptId");

-- CreateIndex
CREATE INDEX "StealthGenerationResult_buildId_idx" ON "StealthGenerationResult"("buildId");

-- CreateIndex
CREATE UNIQUE INDEX "StealthGenerationResult_runId_promptId_key" ON "StealthGenerationResult"("runId", "promptId");

-- CreateIndex
CREATE INDEX "ArenaVoteJob_stealthVariantId_processedAt_idx" ON "ArenaVoteJob"("stealthVariantId", "processedAt");

-- CreateIndex
CREATE INDEX "Matchup_stealthVariantId_createdAt_idx" ON "Matchup"("stealthVariantId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthExperiment" ADD CONSTRAINT "StealthExperiment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthVariant" ADD CONSTRAINT "StealthVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "StealthExperiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthVariant" ADD CONSTRAINT "StealthVariant_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthVariant" ADD CONSTRAINT "StealthVariant_releasedModelId_fkey" FOREIGN KEY ("releasedModelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthEndpointCredential" ADD CONSTRAINT "StealthEndpointCredential_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "StealthVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthGenerationRun" ADD CONSTRAINT "StealthGenerationRun_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "StealthVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthGenerationResult" ADD CONSTRAINT "StealthGenerationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "StealthGenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthGenerationResult" ADD CONSTRAINT "StealthGenerationResult_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "Prompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StealthGenerationResult" ADD CONSTRAINT "StealthGenerationResult_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matchup" ADD CONSTRAINT "Matchup_stealthVariantId_fkey" FOREIGN KEY ("stealthVariantId") REFERENCES "StealthVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArenaVoteJob" ADD CONSTRAINT "ArenaVoteJob_stealthVariantId_fkey" FOREIGN KEY ("stealthVariantId") REFERENCES "StealthVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Guard lifecycle and aggregate fields even when writes bypass Prisma
ALTER TABLE "StealthExperiment"
  ADD CONSTRAINT "StealthExperiment_targetDecisiveVotes_check"
  CHECK ("targetDecisiveVotes" > 0);

ALTER TABLE "StealthVariant"
  ADD CONSTRAINT "StealthVariant_counts_check"
  CHECK (
    "expectedBuildCount" >= 0 AND
    "generatedBuildCount" >= 0 AND
    "generationFailureCount" >= 0 AND
    "shownCount" >= 0 AND
    "winCount" >= 0 AND
    "lossCount" >= 0 AND
    "drawCount" >= 0 AND
    "bothBadCount" >= 0
  );

ALTER TABLE "StealthGenerationRun"
  ADD CONSTRAINT "StealthGenerationRun_counts_check"
  CHECK (
    "expectedBuildCount" > 0 AND
    "completedBuildCount" >= 0 AND
    "failedBuildCount" >= 0 AND
    "providerCallCount" >= 0 AND
    "retryCount" >= 0
  );

ALTER TABLE "StealthGenerationResult"
  ADD CONSTRAINT "StealthGenerationResult_metrics_check"
  CHECK ("attempts" >= 0 AND "generationTimeMs" >= 0);

-- Lab data is readable only by authenticated members of its organization
-- Endpoint credentials intentionally have no readable client policy
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StealthExperiment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StealthVariant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StealthEndpointCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StealthGenerationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StealthGenerationResult" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON TYPE
      "OrganizationRole",
      "StealthExportPolicy",
      "StealthExperimentStatus",
      "StealthVariantStatus",
      "StealthGenerationRunStatus",
      "StealthGenerationResultStatus"
    TO authenticated;

    GRANT SELECT ON
      "User",
      "Organization",
      "OrganizationMembership",
      "OrganizationInvitation",
      "StealthExperiment",
      "StealthVariant",
      "StealthGenerationRun",
      "StealthGenerationResult"
    TO authenticated;

    REVOKE ALL ON "StealthEndpointCredential" FROM authenticated;

    CREATE POLICY "lab_user_self_select"
      ON "User" FOR SELECT TO authenticated
      USING ("id" = (SELECT auth.uid()));

    CREATE POLICY "lab_membership_self_select"
      ON "OrganizationMembership" FOR SELECT TO authenticated
      USING ("userId" = (SELECT auth.uid()));

    CREATE POLICY "lab_organization_member_select"
      ON "Organization" FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1
        FROM "OrganizationMembership" membership
        WHERE membership."organizationId" = "Organization"."id"
          AND membership."userId" = (SELECT auth.uid())
      ));

    CREATE POLICY "lab_invitation_admin_select"
      ON "OrganizationInvitation" FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1
        FROM "OrganizationMembership" membership
        WHERE membership."organizationId" = "OrganizationInvitation"."organizationId"
          AND membership."userId" = (SELECT auth.uid())
          AND membership."role" IN ('OWNER', 'ADMIN')
      ));

    CREATE POLICY "lab_experiment_member_select"
      ON "StealthExperiment" FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1
        FROM "OrganizationMembership" membership
        WHERE membership."organizationId" = "StealthExperiment"."organizationId"
          AND membership."userId" = (SELECT auth.uid())
      ));

    CREATE POLICY "lab_variant_member_select"
      ON "StealthVariant" FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1
        FROM "StealthExperiment" experiment
        INNER JOIN "OrganizationMembership" membership
          ON membership."organizationId" = experiment."organizationId"
        WHERE experiment."id" = "StealthVariant"."experimentId"
          AND membership."userId" = (SELECT auth.uid())
      ));

    CREATE POLICY "lab_generation_run_member_select"
      ON "StealthGenerationRun" FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1
        FROM "StealthVariant" variant
        INNER JOIN "StealthExperiment" experiment
          ON experiment."id" = variant."experimentId"
        INNER JOIN "OrganizationMembership" membership
          ON membership."organizationId" = experiment."organizationId"
        WHERE variant."id" = "StealthGenerationRun"."variantId"
          AND membership."userId" = (SELECT auth.uid())
      ));

    CREATE POLICY "lab_generation_result_member_select"
      ON "StealthGenerationResult" FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1
        FROM "StealthGenerationRun" run
        INNER JOIN "StealthVariant" variant ON variant."id" = run."variantId"
        INNER JOIN "StealthExperiment" experiment
          ON experiment."id" = variant."experimentId"
        INNER JOIN "OrganizationMembership" membership
          ON membership."organizationId" = experiment."organizationId"
        WHERE run."id" = "StealthGenerationResult"."runId"
          AND membership."userId" = (SELECT auth.uid())
      ));

    CREATE POLICY "deny_client_access"
      ON "StealthEndpointCredential" FOR ALL TO authenticated
      USING (false) WITH CHECK (false);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON
      "User",
      "Organization",
      "OrganizationMembership",
      "OrganizationInvitation",
      "StealthExperiment",
      "StealthVariant",
      "StealthEndpointCredential",
      "StealthGenerationRun",
      "StealthGenerationResult"
    FROM anon;
  END IF;
END $$;
