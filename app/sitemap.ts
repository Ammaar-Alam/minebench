import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

const PUBLIC_ROUTES = [
  { path: "/", priority: 1, changeFrequency: "daily" },
  { path: "/sandbox", priority: 0.9, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.8, changeFrequency: "hourly" },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
