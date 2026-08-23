import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ModelDetail } from "@/components/leaderboard/ModelDetail";
import { getModelDetailStats } from "@/lib/arena/stats";
import { findCatalogEntryBySlugOrKey } from "@/lib/ai/modelCatalog";
import { absoluteUrl, breadcrumbJsonLd, DEFAULT_OG_IMAGE, modelDetailJsonLd } from "@/lib/seo";

// ISR for model detail; vote drains can stale a snapshot but it self-refreshes within revalidate.
export const revalidate = 60;

type PageProps = {
  params: Promise<{
    modelKey: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { modelKey } = await params;
  const entry = findCatalogEntryBySlugOrKey(modelKey);
  const canonicalSlug = entry?.slug ?? modelKey;
  const canonicalPath = `/leaderboard/${encodeURIComponent(canonicalSlug)}`;
  const canonicalUrl = absoluteUrl(canonicalPath);
  const modelName = entry?.displayName ?? decodeURIComponent(modelKey).replace(/[-_]+/g, " ").trim();
  const title = `${modelName} — Benchmark Stats`;
  const description = `Spatial reasoning benchmark performance, Elo rating, win rates, and 3D voxel build breakdowns for ${modelName} on MineBench.`;

  return {
    title,
    description,
    keywords: [
      `${modelName} benchmark`,
      `${modelName} leaderboard`,
      `${modelName} spatial reasoning`,
      `${modelName} minecraft ai`,
      `${modelName} voxel benchmark`,
      "MineBench model profile",
      "AI voxel benchmark stats",
    ],
    robots: {
      index: true,
      follow: true,
    },
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${modelName} | MineBench Model Profile`,
      description,
      url: canonicalUrl,
      images: [{ url: DEFAULT_OG_IMAGE, alt: `${modelName} MineBench model profile` }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${modelName} | MineBench Model Profile`,
      description,
      images: [DEFAULT_OG_IMAGE],
    },
  };
}

export default async function ModelLeaderboardPage({ params }: PageProps) {
  const { modelKey } = await params;
  const entry = findCatalogEntryBySlugOrKey(modelKey);
  if (entry && modelKey !== entry.slug) {
    permanentRedirect(`/leaderboard/${encodeURIComponent(entry.slug)}`);
  }

  const data = await getModelDetailStats(modelKey);
  if (!data) notFound();

  const canonicalSlug = data.model.slug ?? entry?.slug ?? data.model.key;

  const breadcrumbData = breadcrumbJsonLd([
    { name: "Arena", path: "/" },
    { name: "Leaderboard", path: "/leaderboard" },
    { name: data.model.displayName, path: `/leaderboard/${encodeURIComponent(canonicalSlug)}` },
  ]);
  const pageData = modelDetailJsonLd({
    key: data.model.key,
    slug: canonicalSlug,
    displayName: data.model.displayName,
    provider: data.model.provider,
    eloRating: data.model.eloRating,
    winCount: data.model.winCount,
    lossCount: data.model.lossCount,
    drawCount: data.model.drawCount,
    bothBadCount: data.model.bothBadCount,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(pageData) }}
      />
      <h1 className="sr-only">{data.model.displayName} MineBench profile</h1>
      <ModelDetail data={data} />
    </>
  );
}
