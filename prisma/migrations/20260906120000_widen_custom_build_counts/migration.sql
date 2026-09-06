ALTER TYPE "CustomBuildArtifactKind" ADD VALUE IF NOT EXISTS 'viewer_world';
ALTER TYPE "CustomBuildArtifactKind" ADD VALUE IF NOT EXISTS 'world_part';

ALTER TABLE "CustomBuild"
  ALTER COLUMN "blockCount" TYPE BIGINT,
  ALTER COLUMN "buildByteSize" TYPE BIGINT,
  ALTER COLUMN "buildCompressedByteSize" TYPE BIGINT,
  ALTER COLUMN "storedByteSize" TYPE BIGINT;

ALTER TABLE "CustomBuildArtifact"
  ALTER COLUMN "byteSize" TYPE BIGINT,
  ALTER COLUMN "compressedByteSize" TYPE BIGINT,
  ALTER COLUMN "storedByteSize" TYPE BIGINT,
  ALTER COLUMN "blockCount" TYPE BIGINT;
