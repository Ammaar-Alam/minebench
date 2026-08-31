import assert from "node:assert/strict";
import { parseGalleryOfficialSeedArgs } from "../../../scripts/seed-gallery-official-prompts";

assert.deepEqual(parseGalleryOfficialSeedArgs([]), { help: false, confirmed: false });
assert.deepEqual(parseGalleryOfficialSeedArgs(["--yes"]), { help: false, confirmed: true });
assert.deepEqual(parseGalleryOfficialSeedArgs(["--help"]), { help: true });
assert.deepEqual(parseGalleryOfficialSeedArgs(["-h"]), { help: true });
assert.throws(() => parseGalleryOfficialSeedArgs(["--yes", "--yes"]), /Pass --yes once/);
assert.throws(() => parseGalleryOfficialSeedArgs(["--all"]), /Unknown argument/);
assert.throws(() => parseGalleryOfficialSeedArgs(["--help", "--yes"]), /Use --help by itself/);

console.log("Gallery official seed argument checks passed");
