ALTER TABLE "User"
  ADD COLUMN "totalGenerationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hostedGenerationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hostedGenerationLimit" INTEGER NOT NULL DEFAULT 100,
  ADD CONSTRAINT "User_totalGenerationCount_check" CHECK ("totalGenerationCount" >= 0),
  ADD CONSTRAINT "User_hostedGenerationCount_check" CHECK ("hostedGenerationCount" >= 0),
  ADD CONSTRAINT "User_hostedGenerationLimit_check" CHECK ("hostedGenerationLimit" >= 0);

UPDATE "User" AS account
SET "totalGenerationCount" = generations.count
FROM (
  SELECT "ownerId", COUNT(*)::INTEGER AS count
  FROM "CustomBuild"
  WHERE "ownerId" IS NOT NULL
  GROUP BY "ownerId"
) AS generations
WHERE account.id = generations."ownerId";

ALTER TABLE "CustomBuild"
  ADD COLUMN "usesHostedGeneration" BOOLEAN NOT NULL DEFAULT false;
