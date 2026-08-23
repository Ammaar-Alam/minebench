import type { MetadataRoute } from "next";
import { MODEL_CATALOG } from "@/lib/ai/modelCatalog";
import { absoluteUrl } from "@/lib/seo";

// Stable baseline timestamp prevents Googlebot from ignoring freshness headers on every crawl
const SITEMAP_LAST_MODIFIED = new Date("2026-08-20T00:00:00.000Z");

const PUBLIC_ROUTES = [
  { path: "/", priority: 1, changeFrequency: "daily" },
  { path: "/sandbox", priority: 0.9, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.9, changeFrequency: "hourly" },
  { path: "/faq", priority: 0.7, changeFrequency: "monthly" },
  { path: "/private-evaluations", priority: 0.8, changeFrequency: "monthly" },
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes = PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: SITEMAP_LAST_MODIFIED,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const modelRoutes = MODEL_CATALOG.filter((model) => model.enabled).map((model) => ({
    url: absoluteUrl(`/leaderboard/${encodeURIComponent(model.slug || model.key)}`),
    lastModified: SITEMAP_LAST_MODIFIED,
    changeFrequency: "daily" as const,
    priority: 0.8,
  }));

  return [...staticRoutes, ...modelRoutes];
}
