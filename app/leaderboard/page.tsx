import type { Metadata } from "next";
import { Leaderboard } from "@/components/leaderboard/Leaderboard";
import { LeaderboardPageShell } from "@/components/leaderboard/LeaderboardPageShell";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Leaderboards",
  description:
    "View live MineBench rankings for AI spatial reasoning and voxel build performance.",
  keywords: [
    "ai benchmark leaderboard",
    "llm leaderboard",
    "voxel benchmark leaderboard",
    "minecraft ai benchmark leaderboard",
  ],
  alternates: {
    canonical: "/leaderboard",
  },
  openGraph: {
    title: "MineBench Leaderboard | AI Benchmark Rankings",
    description: "View live MineBench rankings for AI spatial reasoning and voxel build performance.",
    url: "/leaderboard",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench AI benchmark leaderboard" }],
  },
  twitter: {
    title: "MineBench Leaderboard | AI Benchmark Rankings",
    description: "View live MineBench rankings for AI spatial reasoning and voxel build performance.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Leaderboard", path: "/leaderboard" },
]);

export default function LeaderboardPage() {
  return (
    <LeaderboardPageShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <h1 className="sr-only">MineBench AI benchmark leaderboard</h1>
      <div className="h-full min-h-0">
        <Leaderboard />
      </div>
    </LeaderboardPageShell>
  );
}
