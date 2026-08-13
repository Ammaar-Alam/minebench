import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  missingCohortArtifacts,
  resolvePublicationModel,
} from "../../../lib/benchmark/publication";
import { getModelByKey } from "../../../lib/ai/modelCatalog";

// Exact identity only: keys and slugs resolve, anything fuzzy fails
assert.equal(resolvePublicationModel("gemini-3-7-flash").key, "gemini_3_7_flash");
assert.equal(resolvePublicationModel("gemini_3_7_flash").key, "gemini_3_7_flash");
assert.throws(() => resolvePublicationModel("gemini"), /Unknown model key or slug/);
assert.throws(() => resolvePublicationModel("gemini-3-7"), /Unknown model key or slug/);
assert.throws(() => resolvePublicationModel("gpt-4-5-web-harness"), /import-only/);

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

console.log("model publish resolution checks passed");
