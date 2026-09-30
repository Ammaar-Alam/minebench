
export function galleryDatabaseTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "unconfigured";
  }
}

export { loadMineBenchGalleryPublisher } from "../lib/gallery/communityGeneration";
