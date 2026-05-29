import type { MetadataRoute } from "next";
import { MODEL_CATALOG } from "@/lib/ai/modelCatalog";
import { absoluteUrl } from "@/lib/seo";

const PUBLIC_ROUTES = [
  { path: "/", priority: 1, changeFrequency: "daily" },
  { path: "/sandbox", priority: 0.9, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.8, changeFrequency: "hourly" },
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes = PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const modelRoutes = MODEL_CATALOG.filter((model) => model.enabled).map((model) => ({
    url: absoluteUrl(`/leaderboard/${model.key}`),
    lastModified: new Date(),
    changeFrequency: "daily" as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...modelRoutes];
}
