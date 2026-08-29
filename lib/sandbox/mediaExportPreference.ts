export type MediaExportQuality = "standard" | "creator";
export type MediaExportFileType = "gif" | "mp4";
export type MediaExportFraming = "full" | "social-safe";

export type MediaExportPreference = Readonly<{
  quality: MediaExportQuality;
  fileType: MediaExportFileType;
  framing: MediaExportFraming;
}>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const LEGACY_MEDIA_EXPORT_PREFERENCE_STORAGE_KEY = "minebench:media-export:v1";
export const MEDIA_EXPORT_PREFERENCE_STORAGE_KEY = "minebench:media-export:v2";
export const DEFAULT_MEDIA_EXPORT_PREFERENCE: MediaExportPreference = {
  quality: "standard",
  fileType: "mp4",
  framing: "social-safe",
};

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function parseMediaExportPreference(raw: string | null): MediaExportPreference {
  if (!raw) return DEFAULT_MEDIA_EXPORT_PREFERENCE;

  try {
    const value = JSON.parse(raw) as {
      quality?: unknown;
      fileType?: unknown;
      framing?: unknown;
    };
    if (value.quality !== "standard" && value.quality !== "creator") {
      return DEFAULT_MEDIA_EXPORT_PREFERENCE;
    }
    if (value.fileType !== "gif" && value.fileType !== "mp4") {
      return DEFAULT_MEDIA_EXPORT_PREFERENCE;
    }
    const framing = value.framing === "full" ? "full" : "social-safe";
    return { quality: value.quality, fileType: value.fileType, framing };
  } catch {
    return DEFAULT_MEDIA_EXPORT_PREFERENCE;
  }
}

export function readMediaExportPreference(
  storage: StorageLike | null = browserStorage(),
): MediaExportPreference {
  if (!storage) return DEFAULT_MEDIA_EXPORT_PREFERENCE;
  try {
    const saved = storage.getItem(MEDIA_EXPORT_PREFERENCE_STORAGE_KEY);
    if (saved) return parseMediaExportPreference(saved);

    const legacy = storage.getItem(LEGACY_MEDIA_EXPORT_PREFERENCE_STORAGE_KEY);
    const migrated = parseMediaExportPreference(legacy);
    if (legacy) {
      storage.setItem(MEDIA_EXPORT_PREFERENCE_STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated;
  } catch {
    return DEFAULT_MEDIA_EXPORT_PREFERENCE;
  }
}

export function writeMediaExportPreference(
  preference: MediaExportPreference,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(MEDIA_EXPORT_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    return false;
  }
}

export function getEffectiveMediaExportFileType(
  preference: MediaExportPreference,
): MediaExportFileType {
  return preference.quality === "creator" ? preference.fileType : "gif";
}
