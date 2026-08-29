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
  { quality: "creator", fileType: "gif", framing: "social-safe" },
  "existing preferences should migrate to the creator-safe default",
);
assert.deepEqual(
  parseMediaExportPreference(
    JSON.stringify({ quality: "creator", fileType: "mp4", framing: "full" }),
  ),
  { quality: "creator", fileType: "mp4", framing: "full" },
);
assert.deepEqual(
  parseMediaExportPreference(JSON.stringify({ quality: "ultra", fileType: "mp4" })),
  DEFAULT_MEDIA_EXPORT_PREFERENCE,
);

assert.equal(
  getEffectiveMediaExportFileType({
    quality: "standard",
    fileType: "mp4",
    framing: "social-safe",
  }),
  "gif",
);
assert.equal(
  getEffectiveMediaExportFileType({
    quality: "creator",
    fileType: "mp4",
    framing: "social-safe",
  }),
  "mp4",
);

let savedKey = "";
let savedValue = "";
const storedValues = new Map<string, string>();
const storage = {
  getItem(key: string) {
    return storedValues.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    savedKey = key;
    savedValue = value;
    storedValues.set(key, value);
  },
};

storedValues.set(
  "minebench:media-export:v1",
  JSON.stringify({ quality: "creator", fileType: "mp4" }),
);
assert.deepEqual(readMediaExportPreference(storage), {
  quality: "creator",
  fileType: "mp4",
  framing: "social-safe",
});
assert.equal(savedKey, MEDIA_EXPORT_PREFERENCE_STORAGE_KEY);
assert.ok(savedValue.includes('"framing":"social-safe"'));

assert.equal(
  writeMediaExportPreference(
    { quality: "creator", fileType: "mp4", framing: "social-safe" },
    storage,
  ),
  true,
);
assert.equal(savedKey, MEDIA_EXPORT_PREFERENCE_STORAGE_KEY);
assert.deepEqual(readMediaExportPreference(storage), {
  quality: "creator",
  fileType: "mp4",
  framing: "social-safe",
});

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
  writeMediaExportPreference(
    { quality: "creator", fileType: "gif", framing: "full" },
    unavailableStorage,
  ),
  false,
);

console.log("media export preference checks passed");
