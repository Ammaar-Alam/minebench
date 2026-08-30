const GALLERY_BUILD_PREFIX = "gallery:";

export function parseExplorerBuildId(value: string):
  | { source: "gallery"; id: string }
  | { source: "benchmark"; id: string } {
  let id = value;
  try {
    id = decodeURIComponent(value);
  } catch {
    // Keep malformed benchmark IDs unchanged so the API can reject them normally
  }

  if (id.startsWith(GALLERY_BUILD_PREFIX) && id.length > GALLERY_BUILD_PREFIX.length) {
    return { source: "gallery", id: id.slice(GALLERY_BUILD_PREFIX.length) };
  }
  return { source: "benchmark", id };
}
