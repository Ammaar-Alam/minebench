import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#06080b",
    theme_color: "#06080b",
    icons: [
      {
        src: "/icon-192.png",
        type: "image/png",
        sizes: "192x192",
      },
      {
        src: "/icon-512.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
  };
}
