import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ModelDetail } from "@/components/leaderboard/ModelDetail";
import { getModelDetailStats } from "@/lib/arena/stats";
import { prisma } from "@/lib/prisma";
import { absoluteUrl, breadcrumbJsonLd, DEFAULT_OG_IMAGE, modelDetailJsonLd } from "@/lib/seo";

type PageProps = {
  params: Promise<{
    modelKey: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { modelKey } = await params;
  const model = await prisma.model.findFirst({
    where: {
      key: modelKey,
      enabled: true,
      isBaseline: false,
    },
    select: {
      displayName: true,
    },
  });

  if (!model) {
    return {
      title: "Model profile",
      description: "Detailed model profile and leaderboard stats on MineBench.",
    };
  }

  const title = `${model.displayName} stats`;
  const description = `Detailed MineBench profile for ${model.displayName}, including consistency, spread, and prompt-level performance.`;
  const canonicalPath = `/leaderboard/${modelKey}`;
  const canonicalUrl = absoluteUrl(canonicalPath);

  return {
    title,
    description,
    keywords: [
      `${model.displayName} benchmark`,
      `${model.displayName} leaderboard`,
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
      title: `${model.displayName} | MineBench model profile`,
      description,
      url: canonicalUrl,
      images: [{ url: DEFAULT_OG_IMAGE, alt: `${model.displayName} MineBench model profile` }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${model.displayName} | MineBench model profile`,
      description,
      images: [DEFAULT_OG_IMAGE],
    },
  };
}

export default async function ModelLeaderboardPage({ params }: PageProps) {
  const { modelKey } = await params;
  const data = await getModelDetailStats(modelKey);
  if (!data) notFound();

  const breadcrumbData = breadcrumbJsonLd([
    { name: "Arena", path: "/" },
    { name: "Leaderboard", path: "/leaderboard" },
    { name: data.model.displayName, path: `/leaderboard/${data.model.key}` },
  ]);
  const pageData = modelDetailJsonLd({
    key: data.model.key,
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
