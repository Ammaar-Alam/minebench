import type { Metadata } from "next";
import { AppPrompt } from "@/components/arena/AppPrompt";
import { Arena } from "@/components/arena/Arena";
import { breadcrumbJsonLd, datasetJsonLd, DEFAULT_OG_IMAGE, SEO_KEYWORDS } from "@/lib/seo";

export const metadata: Metadata = {
  description:
    "Compare AI models in a Minecraft-style voxel build benchmark. Vote on head-to-head generations and track a live LLM leaderboard.",
  keywords: [...SEO_KEYWORDS],
  alternates: {
    canonical: "/",
  },
  // Safari's Smart App Banner; Arena only so it greets visitors without following them around
  itunes: { appId: "6803704037", appArgument: "https://minebench.ai/" },
  openGraph: {
    title: "MineBench | Voxel Build AI Benchmark",
    description:
      "Compare AI models in a Minecraft-style voxel build benchmark with live voting and rankings.",
    url: "/",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench arena with two voxel builds" }],
  },
  twitter: {
    title: "MineBench | Voxel Build AI Benchmark",
    description:
      "Compare AI models in a Minecraft-style voxel build benchmark with live voting and rankings.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([{ name: "Arena", path: "/" }]);

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <h1 className="sr-only">MineBench AI voxel build benchmark</h1>
      <Arena />
      <AppPrompt />
    </>
  );
}
