import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertPublicationTargetsAgree,
  missingCohortArtifacts,
  resolvePublicationModel,
} from "../../../lib/benchmark/publication";
import { getModelByKey } from "../../../lib/ai/modelCatalog";

// Exact identity only: keys and slugs resolve, anything fuzzy fails
assert.equal(resolvePublicationModel("gemini-3-7-flash").key, "gemini_3_7_flash");
assert.equal(resolvePublicationModel("gemini_3_7_flash").key, "gemini_3_7_flash");
assert.throws(() => resolvePublicationModel("gemini"), /Unknown model key or slug/);
assert.throws(() => resolvePublicationModel("gemini-3-7"), /Unknown model key or slug/);
// import-only models cannot be generated, but publication is the only path
// that activates a staged model, so they must resolve here
assert.equal(
  resolvePublicationModel("gpt-4-5-web-harness").importOnly,
  true,
  "import-only models must be publishable once their cohort is supplied",
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
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

async function main() {
  try {
    process.env.DATABASE_URL = "postgresql://user:pass@db.example.test:5432/minebench";
    process.env.ADMIN_TOKEN = "test-admin-token";
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    globalThis.fetch = async () =>
      Response.json({
        db: { host: "db.example.test", port: "5432", database: "minebench" },
        arena: { matchupStateCacheTtlMs: 12_345 },
      });
    assert.deepEqual(await assertPublicationTargetsAgree("https://minebench.test"), {
      matchupStateCacheTtlMs: 12_345,
    });

    globalThis.fetch = async () =>
      Response.json({ db: { host: "db.example.test", port: "5432", database: "minebench" } });
    await assert.rejects(
      assertPublicationTargetsAgree("https://minebench.test"),
      /no valid matchup cache TTL/,
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
