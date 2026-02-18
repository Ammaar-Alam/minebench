import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";
import { prisma } from "@/lib/prisma";

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

  let modelRoutes: MetadataRoute.Sitemap | null = null;

  try {
    const modelPages = await prisma.model.findMany({
      where: { enabled: true, isBaseline: false },
      select: { key: true, updatedAt: true },
    });

    modelRoutes = modelPages.map((model) => ({
      url: absoluteUrl(`/leaderboard/${model.key}`),
      lastModified: model.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.7,
    }));
  } catch (error) {
    console.error("Sitemap: unable to load model routes, falling back to static URLs", error);
  }

  return modelRoutes ? [...staticRoutes, ...modelRoutes] : staticRoutes;
}
