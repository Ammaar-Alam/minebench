import assert from "node:assert/strict";
import {
  DEFAULT_MEDIA_EXPORT_PREFERENCE,
  getEffectiveMediaExportFileType,
  MEDIA_EXPORT_PREFERENCE_STORAGE_KEY,
  parseMediaExportPreference,
  readMediaExportPreference,
  writeMediaExportPreference,
} from "../../../lib/sandbox/mediaExportPreference";

assert.deepEqual(parseMediaExportPreference(null), DEFAULT_MEDIA_EXPORT_PREFERENCE);
assert.deepEqual(parseMediaExportPreference("not-json"), DEFAULT_MEDIA_EXPORT_PREFERENCE);
assert.deepEqual(
  parseMediaExportPreference(JSON.stringify({ quality: "creator", fileType: "gif" })),
  { quality: "creator", fileType: "gif" },
);
assert.deepEqual(
  parseMediaExportPreference(JSON.stringify({ quality: "ultra", fileType: "mp4" })),
  DEFAULT_MEDIA_EXPORT_PREFERENCE,
);

assert.equal(
  getEffectiveMediaExportFileType({ quality: "standard", fileType: "mp4" }),
  "gif",
);
assert.equal(
  getEffectiveMediaExportFileType({ quality: "creator", fileType: "mp4" }),
  "mp4",
);

let savedKey = "";
let savedValue = "";
const storage = {
  getItem(key: string) {
    return key === MEDIA_EXPORT_PREFERENCE_STORAGE_KEY ? savedValue || null : null;
  },
  setItem(key: string, value: string) {
    savedKey = key;
    savedValue = value;
  },
};

assert.equal(
  writeMediaExportPreference({ quality: "creator", fileType: "mp4" }, storage),
  true,
);
assert.equal(savedKey, MEDIA_EXPORT_PREFERENCE_STORAGE_KEY);
assert.deepEqual(readMediaExportPreference(storage), { quality: "creator", fileType: "mp4" });

const unavailableStorage = {
  getItem() {
    throw new Error("disabled");
  },
  setItem() {
    throw new Error("disabled");
  },
};
assert.deepEqual(readMediaExportPreference(unavailableStorage), DEFAULT_MEDIA_EXPORT_PREFERENCE);
assert.equal(
  writeMediaExportPreference({ quality: "creator", fileType: "gif" }, unavailableStorage),
  false,
);

console.log("media export preference checks passed");
