import type { Metadata } from "next";
import { Leaderboard } from "@/components/leaderboard/Leaderboard";
import { LeaderboardPageShell } from "@/components/leaderboard/LeaderboardPageShell";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE, leaderboardItemListJsonLd } from "@/lib/seo";
import { getLeaderboardItemListRankings } from "@/lib/arena/stats";
import { getLeaderboardData } from "@/lib/arena/leaderboard";
import type { LeaderboardResponse } from "@/lib/arena/types";

// ISR for leaderboard; refreshes crawlable rankings and ItemList structured data periodically.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Leaderboard",
  description:
    "Live AI model leaderboard comparing LLM spatial reasoning on 3D voxel builds. Track Elo ratings, win rates, and benchmark rankings.",
  keywords: [
    "ai benchmark leaderboard",
    "llm leaderboard",
    "voxel benchmark leaderboard",
    "voxelbench",
    "voxelbench alternative",
    "minecraft ai benchmark leaderboard",
    "spatial reasoning benchmark",
  ],
  alternates: {
    canonical: "/leaderboard",
  },
  openGraph: {
    title: "MineBench Leaderboard | AI Spatial Reasoning Rankings",
    description: "Live AI model leaderboard comparing LLM spatial reasoning on 3D voxel builds.",
    url: "/leaderboard",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench AI benchmark leaderboard" }],
  },
  twitter: {
    title: "MineBench Leaderboard | AI Spatial Reasoning Rankings",
    description: "Live AI model leaderboard comparing LLM spatial reasoning on 3D voxel builds.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Leaderboard", path: "/leaderboard" },
]);

export default async function LeaderboardPage() {
  let initialData: LeaderboardResponse | null = null;
  try {
    initialData = (await getLeaderboardData()).data;
  } catch {
    // The client keeps the existing retry and stale-cache recovery path
  }

  const rankings = initialData
    ? initialData.models.map((model, index) => ({
        name: model.displayName,
        rank: index + 1,
        path: `/leaderboard/${encodeURIComponent(model.slug ?? model.key)}`,
      }))
    : await getLeaderboardItemListRankings();
  const itemListData = rankings.length > 0 ? leaderboardItemListJsonLd(rankings) : null;

  return (
    <LeaderboardPageShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      {itemListData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListData) }}
        />
      )}
      <h1 className="sr-only">MineBench AI benchmark leaderboard</h1>
      <div className="h-full min-h-0">
        <Leaderboard initialData={initialData} />
      </div>
    </LeaderboardPageShell>
  );
}
