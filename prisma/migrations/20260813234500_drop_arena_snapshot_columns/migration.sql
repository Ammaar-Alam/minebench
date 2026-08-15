-- Snapshot payloads are served from checksum-addressed storage artifacts;
-- the legacy Build columns held redundant copies (~377MB of the relation).
-- Deploy the code that stops selecting these columns BEFORE running this
-- migration. Freed pages become reusable after autovacuum; physical shrink
-- (VACUUM FULL / pg_repack) is a separately scheduled operation.

ALTER TABLE "Build" DROP COLUMN IF EXISTS "arenaSnapshotPreview";
ALTER TABLE "Build" DROP COLUMN IF EXISTS "arenaSnapshotPreviewChecksum";
ALTER TABLE "Build" DROP COLUMN IF EXISTS "arenaSnapshotFull";
ALTER TABLE "Build" DROP COLUMN IF EXISTS "arenaSnapshotFullChecksum";
