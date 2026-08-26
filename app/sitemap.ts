import type { MetadataRoute } from "next";
import { MODEL_CATALOG } from "@/lib/ai/modelCatalog";
import { absoluteUrl } from "@/lib/seo";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Stable baseline timestamp prevents Googlebot from ignoring freshness headers on every crawl
const SITEMAP_LAST_MODIFIED = new Date("2026-08-23T00:00:00.000Z");

const PUBLIC_ROUTES = [
  { path: "/", priority: 1, changeFrequency: "daily" },
  { path: "/sandbox", priority: 0.9, changeFrequency: "daily" },
  { path: "/gallery", priority: 0.9, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.9, changeFrequency: "hourly" },
  { path: "/faq", priority: 0.7, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.6, changeFrequency: "monthly" },
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

  let candidates: Array<{ publicId: string; updatedAt: Date }>;
  try {
    candidates = await prisma.galleryCandidate.findMany({
      where: {
        removedAt: null,
        adminHiddenAt: null,
        OR: [{ selectedAt: { not: null } }, { uploader: { gallerySuspendedAt: null } }],
      },
      select: { publicId: true, updatedAt: true },
      orderBy: { publishedAt: "desc" },
      take: 10_000,
    });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2021") throw error;
    candidates = [];
  }
  const galleryRoutes = candidates.map((candidate) => ({
    url: absoluteUrl(`/gallery/${candidate.publicId}`),
    lastModified: candidate.updatedAt,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...modelRoutes, ...galleryRoutes];
}
