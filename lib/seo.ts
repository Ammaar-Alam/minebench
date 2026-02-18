import { summarizeArenaVotes } from "@/lib/arena/voteMath";

export const SITE_NAME = "MineBench";
export const SITE_URL = "https://minebench.ai";
export const SITE_HOST = "minebench.ai";
export const LEGACY_HOSTS = new Set(["minebench.vercel.app", "www.minebench.ai"]);

export const SITE_DESCRIPTION =
  "MineBench is an AI benchmark for Minecraft-style voxel builds. Compare LLM spatial reasoning with head-to-head votes, live generation, and a public leaderboard.";

export const DEFAULT_OG_IMAGE = "/readme/arena-dark.png";

export const SEO_KEYWORDS = [
  "MineBench",
  "voxel build benchmark",
  "voxel benchmark",
  "llm benchmark",
  "ai benchmark",
  "minecraft ai benchmark",
  "minecraft benchmark",
  "spatial reasoning benchmark",
  "3D reasoning benchmark",
  "AI model leaderboard",
  "LLM leaderboard",
  "AI spatial reasoning",
] as const;

export function absoluteUrl(path = "/") {
  return new URL(path, SITE_URL).toString();
}

export function breadcrumbJsonLd(
  items: Array<{
    name: string;
    path: string;
  }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  inLanguage: "en-US",
  potentialAction: {
    "@type": "SearchAction",
    target: `${SITE_URL}/sandbox?prompt={search_term_string}`,
    "query-input": "required name=search_term_string",
  },
};

export const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  keywords: SEO_KEYWORDS.join(", "),
  featureList: [
    "Head-to-head AI model comparison for voxel builds",
    "Prompt-driven sandbox generation",
    "Leaderboard with live model rankings",
  ],
};

export function modelDetailJsonLd(params: {
  key: string;
  displayName: string;
  provider: string;
  eloRating: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
}) {
  const { decisiveVotes, totalVotes } = summarizeArenaVotes(params);
  const winRate = decisiveVotes > 0 ? params.winCount / decisiveVotes : null;

  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${params.displayName} stats | ${SITE_NAME}`,
    url: absoluteUrl(`/leaderboard/${params.key}`),
    isPartOf: {
      "@type": "WebSite",
      name: SITE_NAME,
      url: SITE_URL,
    },
    about: {
      "@type": "SoftwareApplication",
      name: params.displayName,
      applicationCategory: "DeveloperApplication",
      provider: {
        "@type": "Organization",
        name: params.provider,
      },
      additionalProperty: [
        {
          "@type": "PropertyValue",
          name: "Elo rating",
          value: Math.round(params.eloRating),
        },
        {
          "@type": "PropertyValue",
          name: "Win rate",
          value: winRate != null ? `${(winRate * 100).toFixed(1)}%` : "N/A",
        },
        {
          "@type": "PropertyValue",
          name: "Decisive votes",
          value: decisiveVotes,
        },
        {
          "@type": "PropertyValue",
          name: "Total votes",
          value: totalVotes,
        },
      ],
    },
  };
}
