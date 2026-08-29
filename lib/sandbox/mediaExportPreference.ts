export type MediaExportQuality = "standard" | "creator";
export type MediaExportFileType = "gif" | "mp4";

export type MediaExportPreference = Readonly<{
  quality: MediaExportQuality;
  fileType: MediaExportFileType;
}>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export const MEDIA_EXPORT_PREFERENCE_STORAGE_KEY = "minebench:media-export:v1";
export const DEFAULT_MEDIA_EXPORT_PREFERENCE: MediaExportPreference = {
  quality: "standard",
  fileType: "mp4",
};

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function parseMediaExportPreference(raw: string | null): MediaExportPreference {
  if (!raw) return DEFAULT_MEDIA_EXPORT_PREFERENCE;

  try {
    const value = JSON.parse(raw) as { quality?: unknown; fileType?: unknown };
    if (value.quality !== "standard" && value.quality !== "creator") {
      return DEFAULT_MEDIA_EXPORT_PREFERENCE;
    }
    if (value.fileType !== "gif" && value.fileType !== "mp4") {
      return DEFAULT_MEDIA_EXPORT_PREFERENCE;
    }
    return { quality: value.quality, fileType: value.fileType };
  } catch {
    return DEFAULT_MEDIA_EXPORT_PREFERENCE;
  }
}

export function readMediaExportPreference(
  storage: StorageLike | null = browserStorage(),
): MediaExportPreference {
  if (!storage) return DEFAULT_MEDIA_EXPORT_PREFERENCE;
  try {
    return parseMediaExportPreference(storage.getItem(MEDIA_EXPORT_PREFERENCE_STORAGE_KEY));
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
