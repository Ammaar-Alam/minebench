-- Allow storing large voxel payloads in object storage and keep DB pointers.
ALTER TABLE "Build"
  ALTER COLUMN "voxelData" DROP NOT NULL;

ALTER TABLE "Build"
  ADD COLUMN "voxelStorageBucket" TEXT,
  ADD COLUMN "voxelStoragePath" TEXT,
  ADD COLUMN "voxelStorageEncoding" TEXT,
  ADD COLUMN "voxelByteSize" INTEGER,
  ADD COLUMN "voxelCompressedByteSize" INTEGER,
  ADD COLUMN "voxelSha256" TEXT;
