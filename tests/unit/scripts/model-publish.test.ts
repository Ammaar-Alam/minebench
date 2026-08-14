import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertDeployedPublicationCoverage,
  assertPublicationTargetsAgree,
  findChangedPublicationPromptSlugs,
  missingCohortArtifacts,
  publicationArtifactChecksum,
  publicationArtifactRepresentation,
  publicationNeedsCacheDrain,
  publicationShouldRestoreAfterGuardFailure,
  resolvePublicationLockDatabaseUrl,
  resolvePublicationModel,
} from "../../../lib/benchmark/publication";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  databaseIdentityFromUrl,
  isLoopbackDatabaseUrl,
  isSameDatabaseTarget,
} from "../../../lib/db/identity";
import { getSupabaseStorageReadiness } from "../../../lib/storage/buildPayload";

const modelPublishSource = fs.readFileSync("scripts/model-publish.ts", "utf8");
const uploadPipelineStart = modelPublishSource.indexOf("// Upload is an idempotent reconcile");
const initialCohortGuard = modelPublishSource.indexOf(
  "await assertRatedModelCohortUnchanged(entry, promptSlugs, UPLOADS_DIR)",
  uploadPipelineStart,
);
const uploadMutationBranch = modelPublishSource.indexOf(
  "if (!opts.dryRun)",
  uploadPipelineStart,
);
assert.ok(uploadPipelineStart >= 0 && initialCohortGuard >= 0 && uploadMutationBranch >= 0);
assert.ok(
  initialCohortGuard < uploadMutationBranch,
  "dry runs must validate rated-cohort provenance before skipping publication writes",
);
const publicationLockAcquire = modelPublishSource.indexOf(
  "publicationLock = await acquireModelPublicationLock(entry.key)",
);
const publicationStage = modelPublishSource.indexOf("stagePublishedModel(entry.key)");
const publicationActivation = modelPublishSource.indexOf("activatePublishedModel(entry.key)");
const publicationLockRelease = modelPublishSource.indexOf("publicationLock?.release()");
assert.ok(
  publicationLockAcquire >= 0 && publicationLockAcquire < publicationStage,
  "real publications must acquire the per-model lock before staging",
);
assert.ok(
  publicationLockRelease > publicationActivation,
  "the per-model publication lock must remain owned through activation",
);

// Exact identity only: keys and slugs resolve, anything fuzzy fails
assert.equal(resolvePublicationModel("gemini-3-7-flash").key, "gemini_3_7_flash");
assert.equal(resolvePublicationModel("gemini_3_7_flash").key, "gemini_3_7_flash");
assert.throws(() => resolvePublicationModel("gemini"), /Unknown model key or slug/);
assert.throws(() => resolvePublicationModel("gemini-3-7"), /Unknown model key or slug/);
assert.throws(() => resolvePublicationModel("gemini_3_0_pro"), /retired in the catalog/);
// import-only models cannot be generated, but publication is the only path
// that activates a staged model, so they must resolve here
assert.equal(
  resolvePublicationModel("gpt-4-5-web-harness").importOnly,
  true,
  "import-only models must be publishable once their cohort is supplied",
);
assert.equal(publicationNeedsCacheDrain("staged"), true);
assert.equal(
  publicationNeedsCacheDrain("already-staged"),
  true,
  "resumed publication should repeat the full cache drain",
);
assert.equal(publicationNeedsCacheDrain("missing"), false);
assert.equal(publicationShouldRestoreAfterGuardFailure("staged"), true);
assert.equal(publicationShouldRestoreAfterGuardFailure("already-staged"), false);
assert.equal(publicationShouldRestoreAfterGuardFailure("missing"), false);

const prettyArtifact = Buffer.from(
  JSON.stringify(
    {
      version: "1.0",
      blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
    },
    null,
    2,
  ),
);
const canonicalArtifact = JSON.stringify({
  version: "1.0",
  boxes: [],
  lines: [],
  blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
});
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
assert.equal(publicationArtifactChecksum(prettyArtifact, "storage"), sha256(prettyArtifact));
assert.equal(publicationArtifactChecksum(prettyArtifact, "inline"), sha256(canonicalArtifact));
assert.notEqual(
  publicationArtifactChecksum(prettyArtifact, "storage"),
  publicationArtifactChecksum(prettyArtifact, "inline"),
  "storage and inline imports intentionally hash different representations",
);
assert.equal(
  publicationArtifactRepresentation({
    voxelStorageBucket: "builds",
    voxelStoragePath: "arena/build.json.gz",
  }),
  "storage",
);
assert.equal(
  publicationArtifactRepresentation({ voxelStorageBucket: null, voxelStoragePath: null }),
  "inline",
);

const currentChecksum = "a".repeat(64);
const incomingCohort = [
  {
    promptSlug: "castle",
    promptText: "A castle",
    voxelSha256: currentChecksum,
  },
];
assert.deepEqual(
  findChangedPublicationPromptSlugs(
    [{ promptText: "A castle", voxelSha256: currentChecksum.toUpperCase() }],
    incomingCohort,
  ),
  [],
  "an idempotent rated-cohort upload should remain allowed",
);
assert.deepEqual(
  findChangedPublicationPromptSlugs(
    [{ promptText: "A castle", voxelSha256: "b".repeat(64) }],
    incomingCohort,
  ),
  ["castle"],
  "a changed rated build should require a new model identity or an explicit history reset",
);

const projectRef = "abcdefghijklmnop";
const deployedDb = {
  projectRef,
  host: `db.${projectRef}.supabase.co`,
  port: "5432",
  database: "postgres",
  schema: "public",
};
const readyStorage = { projectRef, bucket: "builds", ready: true, error: null };
const directPublic = databaseIdentityFromUrl(
  `postgresql://postgres:pass@db.${projectRef}.supabase.co:5432/postgres`,
);
const pooledPublic = databaseIdentityFromUrl(
  `postgresql://postgres.${projectRef}:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?schema=public`,
);
const customRolePooledPublic = databaseIdentityFromUrl(
  `postgresql://prisma.${projectRef}:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?schema=public`,
);
const unidentifiedPooledPublic = databaseIdentityFromUrl(
  "postgresql://prisma:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?schema=public",
);
const directStaging = databaseIdentityFromUrl(
  `postgresql://postgres:pass@db.${projectRef}.supabase.co:5432/postgres?schema=staging`,
);
const directOtherDatabase = databaseIdentityFromUrl(
  `postgresql://postgres:pass@db.${projectRef}.supabase.co:5432/minebench?schema=public`,
);
assert.ok(
  directPublic &&
    pooledPublic &&
    customRolePooledPublic &&
    unidentifiedPooledPublic &&
    directStaging &&
    directOtherDatabase,
);
assert.equal(isSameDatabaseTarget(directPublic, pooledPublic), true);
assert.equal(customRolePooledPublic.projectRef, projectRef);
assert.equal(isSameDatabaseTarget(directPublic, customRolePooledPublic), true);
assert.equal(
  isSameDatabaseTarget(unidentifiedPooledPublic, pooledPublic),
  false,
  "one-sided Supabase project identities must fail closed",
);
assert.equal(isSameDatabaseTarget(directPublic, directStaging), false);
assert.equal(isSameDatabaseTarget(directPublic, directOtherDatabase), false);

const publicationLockUrl = new URL(
  resolvePublicationLockDatabaseUrl(
    `postgresql://prisma.${projectRef}:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?schema=public`,
    `postgresql://postgres:pass@db.${projectRef}.supabase.co:5432/postgres?schema=public`,
  ),
);
assert.equal(publicationLockUrl.hostname, `db.${projectRef}.supabase.co`);
assert.equal(publicationLockUrl.searchParams.get("connection_limit"), "1");
assert.throws(
  () =>
    resolvePublicationLockDatabaseUrl(
      `postgresql://postgres.${projectRef}:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      "postgresql://postgres:pass@db.ponmlkjihgfedcba.supabase.co:5432/postgres",
    ),
  /different database target/,
);
assert.throws(
  () =>
    resolvePublicationLockDatabaseUrl(
      `postgresql://postgres.${projectRef}:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      "",
    ),
  /DIRECT_URL.*session-affine/,
);
assert.equal(
  isLoopbackDatabaseUrl("postgresql://minebench:minebench@localhost:54327/minebench"),
  true,
);
assert.equal(
  isLoopbackDatabaseUrl("postgresql://minebench:minebench@127.0.0.1:54327/minebench"),
  true,
);
assert.equal(
  isLoopbackDatabaseUrl("postgresql://minebench:minebench@[::1]:54327/minebench"),
  true,
);
assert.equal(
  isLoopbackDatabaseUrl(`postgresql://postgres:pass@db.${projectRef}.supabase.co/postgres`),
  false,
);

// Cohort completeness reports every absent or empty artifact
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-test-"));
try {
  const entry = getModelByKey("gemini_3_7_flash");
  const slugs = ["castle", "cottage"];
  fs.mkdirSync(path.join(tmpDir, "castle"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "castle", `castle-${entry.slug}.json`), "{}");
  fs.mkdirSync(path.join(tmpDir, "cottage"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "cottage", `cottage-${entry.slug}.json`), "");

  const missing = missingCohortArtifacts(entry, slugs, tmpDir);
  assert.equal(missing.length, 1, "empty artifacts should count as missing");
  assert.ok(missing[0].endsWith(`cottage-${entry.slug}.json`));

  const missingAll = missingCohortArtifacts(entry, ["arcade", ...slugs], tmpDir);
  assert.equal(missingAll.length, 2, "absent prompt directories should count as missing");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const envKeys = [
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_STORAGE_BUCKET",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

async function main() {
  try {
    process.env.DATABASE_URL =
      `postgresql://postgres:pass@db.${projectRef}.supabase.co:5432/postgres`;
    process.env.ADMIN_TOKEN = "test-admin-token";
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_STORAGE_BUCKET;

    globalThis.fetch = async () =>
      Response.json({
        db: deployedDb,
        arena: { matchupStateCacheTtlMs: 12_345 },
        storage: readyStorage,
      });
    assert.deepEqual(await assertPublicationTargetsAgree("https://minebench.test"), {
      matchupStateCacheTtlMs: 12_345,
    });

    process.env.SUPABASE_URL = "https://staleprojectref1234.supabase.co";
    assert.deepEqual(await assertPublicationTargetsAgree("https://minebench.test"), {
      matchupStateCacheTtlMs: 12_345,
    });

    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    await assert.rejects(
      assertPublicationTargetsAgree("https://minebench.test"),
      /Publication storage mismatch/,
    );
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    globalThis.fetch = async () =>
      Response.json({
        db: deployedDb,
        storage: readyStorage,
      });
    await assert.rejects(
      assertPublicationTargetsAgree("https://minebench.test"),
      /no valid matchup cache TTL/,
    );

    globalThis.fetch = async () =>
      Response.json({
        db: deployedDb,
        arena: { matchupStateCacheTtlMs: 12_345 },
        storage: {
          projectRef,
          bucket: "builds",
          ready: false,
          error: "Storage list probe failed (401)",
        },
      });
    await assert.rejects(
      assertPublicationTargetsAgree("https://minebench.test"),
      /deployed storage is not ready.*401/,
    );

    globalThis.fetch = async () =>
      Response.json({
        db: deployedDb,
        arena: { matchupStateCacheTtlMs: 12_345 },
        storage: {
          projectRef: "differentref12345",
          bucket: "builds",
          ready: true,
          error: null,
        },
      });
    await assert.rejects(
      assertPublicationTargetsAgree("https://minebench.test"),
      /Publication deployment mismatch/,
    );

    process.env.SUPABASE_URL = `https://${projectRef}.supabase.co`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.SUPABASE_STORAGE_BUCKET = "builds";
    let storageProbeUrl = "";
    let storageProbeInit: RequestInit | undefined;
    globalThis.fetch = async (input, init) => {
      storageProbeUrl = String(input);
      storageProbeInit = init;
      return Response.json([]);
    };
    assert.deepEqual(await getSupabaseStorageReadiness(), {
      projectRef,
      bucket: "builds",
      ready: true,
      error: null,
    });
    assert.equal(
      storageProbeUrl,
      `https://${projectRef}.supabase.co/storage/v1/object/list/builds`,
    );
    assert.equal(storageProbeInit?.method, "POST");
    const storageProbeHeaders = new Headers(storageProbeInit?.headers);
    assert.equal(storageProbeHeaders.get("authorization"), "Bearer test-service-role-key");
    assert.equal(storageProbeHeaders.get("apikey"), "test-service-role-key");

    globalThis.fetch = async () => Response.json({}, { status: 401 });
    assert.deepEqual(await getSupabaseStorageReadiness(), {
      projectRef,
      bucket: "builds",
      ready: false,
      error: "Storage list probe failed (401)",
    });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_STORAGE_BUCKET;

    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = " test-bypass-secret ";
    let deployedStatusUrl = "";
    let deployedStatusHeaders = new Headers();
    globalThis.fetch = async (input, init) => {
      deployedStatusUrl = String(input);
      deployedStatusHeaders = new Headers(init?.headers);
      return Response.json({
        artifacts: {
          modelKey: "gemini_3_7_flash",
          missingBuildIds: [],
          error: null,
        },
      });
    };
    await assertDeployedPublicationCoverage(
      "https://minebench.test/",
      "gemini_3_7_flash",
    );
    assert.equal(
      new URL(deployedStatusUrl).searchParams.get("modelKey"),
      "gemini_3_7_flash",
    );
    assert.equal(deployedStatusHeaders.get("authorization"), "Bearer test-admin-token");
    assert.equal(
      deployedStatusHeaders.get("x-vercel-protection-bypass"),
      "test-bypass-secret",
    );

    globalThis.fetch = async () =>
      Response.json({
        artifacts: {
          modelKey: "gemini_3_7_flash",
          missingBuildIds: ["missing-build"],
          error: null,
        },
      });
    await assert.rejects(
      assertDeployedPublicationCoverage("https://minebench.test", "gemini_3_7_flash"),
      /1 build\(s\) needing work/,
    );

    console.log("model publish resolution checks passed");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
