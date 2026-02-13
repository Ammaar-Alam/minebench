import type { Metadata } from "next";
import { Arena } from "@/components/arena/Arena";
import { DEFAULT_OG_IMAGE, SEO_KEYWORDS } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Voxel Build AI Benchmark",
  description:
    "Compare AI models in a Minecraft-style voxel build benchmark. Vote on head-to-head generations and track a live LLM leaderboard.",
  keywords: [...SEO_KEYWORDS],
  alternates: {
    canonical: "/",
  },
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

export default function HomePage() {
  return (
    <>
      <h1 className="sr-only">MineBench AI voxel build benchmark</h1>
      <Arena />
    </>
  );
}
