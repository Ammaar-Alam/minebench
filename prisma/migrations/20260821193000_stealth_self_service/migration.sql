-- Private evaluation data is available only through server-side authorization.
DROP POLICY IF EXISTS "lab_user_self_select" ON "User";
DROP POLICY IF EXISTS "lab_membership_self_select" ON "OrganizationMembership";
DROP POLICY IF EXISTS "lab_organization_member_select" ON "Organization";
DROP POLICY IF EXISTS "lab_invitation_admin_select" ON "OrganizationInvitation";
DROP POLICY IF EXISTS "lab_experiment_member_select" ON "StealthExperiment";
DROP POLICY IF EXISTS "lab_variant_member_select" ON "StealthVariant";
DROP POLICY IF EXISTS "lab_generation_run_member_select" ON "StealthGenerationRun";
DROP POLICY IF EXISTS "lab_generation_result_member_select" ON "StealthGenerationResult";
DROP POLICY IF EXISTS "deny_client_access" ON "StealthEndpointCredential";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
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
    FROM authenticated;

    REVOKE USAGE ON TYPE
      "OrganizationRole",
      "StealthExportPolicy",
      "StealthExperimentStatus",
      "StealthVariantStatus",
      "StealthGenerationRunStatus",
      "StealthGenerationResultStatus"
    FROM authenticated;
  END IF;
END $$;

ALTER TABLE "User"
  ADD COLUMN "isMineBenchAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Reduce organization access to the Admin and Member roles.
ALTER TYPE "OrganizationRole" RENAME TO "OrganizationRole_old";
CREATE TYPE "OrganizationRole" AS ENUM ('ADMIN', 'MEMBER');

ALTER TABLE "OrganizationMembership"
  ALTER COLUMN "role" TYPE "OrganizationRole"
  USING (
    CASE
      WHEN "role"::text IN ('OWNER', 'ADMIN') THEN 'ADMIN'
      WHEN "role"::text IN ('ANALYST', 'VIEWER') THEN 'MEMBER'
    END
  )::text::"OrganizationRole";

ALTER TABLE "OrganizationInvitation"
  ALTER COLUMN "role" TYPE "OrganizationRole"
  USING (
    CASE
      WHEN "role"::text IN ('OWNER', 'ADMIN') THEN 'ADMIN'
      WHEN "role"::text IN ('ANALYST', 'VIEWER') THEN 'MEMBER'
    END
  )::text::"OrganizationRole";

DROP TYPE "OrganizationRole_old";

-- Keep the top-level lifecycle to the states exposed in the workspace.
ALTER TYPE "StealthExperimentStatus" RENAME TO "StealthExperimentStatus_old";
CREATE TYPE "StealthExperimentStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'ACTIVE', 'PAUSED', 'CLOSED');

ALTER TABLE "StealthExperiment"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "StealthExperimentStatus"
  USING (
    CASE
      WHEN "status"::text = 'DRAFT' THEN 'DRAFT'
      WHEN "status"::text IN ('VALIDATING', 'GENERATING', 'DEGRADED') THEN 'GENERATING'
      WHEN "status"::text = 'READY' THEN 'READY'
      WHEN "status"::text IN ('ACTIVE', 'STABLE') THEN 'ACTIVE'
      WHEN "status"::text = 'PAUSED' THEN 'PAUSED'
      WHEN "status"::text IN ('WITHDRAWN', 'CLOSED', 'RELEASED') THEN 'CLOSED'
    END
  )::text::"StealthExperimentStatus",
  ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "StealthExperimentStatus_old";

ALTER TYPE "StealthVariantStatus" RENAME TO "StealthVariantStatus_old";
CREATE TYPE "StealthVariantStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'ACTIVE', 'WITHDRAWN');
CREATE TYPE "StealthVariantSource" AS ENUM ('ENDPOINT', 'UPLOAD');

ALTER TABLE "StealthVariant"
  ADD COLUMN "source" "StealthVariantSource" NOT NULL DEFAULT 'ENDPOINT',
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "StealthVariantStatus"
  USING (
    CASE
      WHEN "status"::text = 'DRAFT' THEN 'DRAFT'
      WHEN "status"::text IN ('VALIDATING', 'GENERATING', 'DEGRADED') THEN 'GENERATING'
      WHEN "status"::text = 'READY' THEN 'READY'
      WHEN "status"::text = 'ACTIVE' THEN 'ACTIVE'
      WHEN "status"::text IN ('WITHDRAWN', 'RELEASED') THEN 'WITHDRAWN'
    END
  )::text::"StealthVariantStatus",
  ALTER COLUMN "status" SET DEFAULT 'DRAFT';

DROP TYPE "StealthVariantStatus_old";

ALTER TYPE "StealthGenerationResultStatus" RENAME TO "StealthGenerationResultStatus_old";
CREATE TYPE "StealthGenerationResultStatus" AS ENUM ('QUEUED', 'GENERATING', 'VALIDATING', 'READY', 'FAILED');

ALTER TABLE "StealthGenerationResult"
  ALTER COLUMN "status" TYPE "StealthGenerationResultStatus"
  USING (
    CASE
      WHEN "status"::text = 'SUCCEEDED' THEN 'READY'
      WHEN "status"::text = 'FAILED' THEN 'FAILED'
    END
  )::text::"StealthGenerationResultStatus",
  ALTER COLUMN "attempts" SET DEFAULT 0,
  ALTER COLUMN "generationTimeMs" SET DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "StealthGenerationResult"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

DROP TYPE "StealthGenerationResultStatus_old";

ALTER TABLE "StealthExperiment"
  ALTER COLUMN "targetDecisiveVotes" DROP DEFAULT,
  ALTER COLUMN "targetDecisiveVotes" DROP NOT NULL,
  ADD COLUMN "pauseAtGoal" BOOLEAN,
  ADD COLUMN "retentionDays" INTEGER,
  ADD COLUMN "checkpointSetFrozenAt" TIMESTAMP(3);

-- Existing vote targets were progress markers, not enforced stopping rules.
UPDATE "StealthExperiment"
SET
  "pauseAtGoal" = false,
  "retentionDays" = CASE
    WHEN "endedAt" IS NOT NULL
      AND "retentionDeleteAt" IS NOT NULL
      AND "retentionDeleteAt" > "endedAt"
    THEN GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM ("retentionDeleteAt" - "endedAt")) / 86400)::integer
    )
    ELSE 30
  END,
  "checkpointSetFrozenAt" = CASE
    WHEN "status" IN ('ACTIVE', 'PAUSED', 'CLOSED')
    THEN COALESCE("startsAt", "endedAt", "updatedAt", "createdAt")
    ELSE NULL
  END;

ALTER TABLE "StealthExperiment"
  ALTER COLUMN "pauseAtGoal" SET DEFAULT true,
  ALTER COLUMN "pauseAtGoal" SET NOT NULL,
  ALTER COLUMN "retentionDays" SET DEFAULT 30,
  ALTER COLUMN "retentionDays" SET NOT NULL,
  ADD CONSTRAINT "StealthExperiment_retentionDays_check" CHECK ("retentionDays" > 0);

ALTER TABLE "StealthGenerationRun"
  ADD COLUMN "workflowRunId" TEXT;

CREATE UNIQUE INDEX "StealthGenerationRun_workflowRunId_key"
  ON "StealthGenerationRun"("workflowRunId");

CREATE INDEX "StealthExperiment_status_retentionDeleteAt_idx"
  ON "StealthExperiment"("status", "retentionDeleteAt");
