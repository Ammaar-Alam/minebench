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
  "Mine Bench",
  "voxel build benchmark",
  "voxel benchmark",
  "voxel bench",
  "voxelbench",
  "voxelbench alternative",
  "llm arena",
  "lm arena",
  "voxel arena",
  "ai model arena",
  "llm benchmark",
  "ai benchmark",
  "minecraft ai benchmark",
  "minecraft benchmark",
  "spatial reasoning benchmark",
  "3D reasoning benchmark",
  "3D spatial reasoning",
  "AI spatial reasoning",
  "AI model leaderboard",
  "LLM leaderboard",
  "open-source voxel AI benchmark",
  "private evals",
  "private model evaluation",
  "private llm benchmark",
  "checkpoint evaluation",
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

export function faqPageJsonLd(
  items: readonly {
    question: string;
    answer: string;
  }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
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
  applicationSubCategory: "AI Spatial Reasoning Benchmark",
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
    "Prompt-driven sandbox generation and 3D spatial evaluation",
    "Leaderboard with live Elo model rankings",
    "Blind LLM arena for 3D spatial reasoning",
    "Confidential private model evaluations and checkpoint benchmarking",
    "Open-source voxel and Minecraft-style LLM spatial reasoning benchmark",
  ],
};

export const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "MineBench AI Spatial Reasoning & Voxel Build Dataset",
  description:
    "Open-source benchmark evaluation dataset measuring 3D spatial reasoning in large language models through Minecraft-style voxel generation tasks and pairwise human evaluations.",
  url: SITE_URL,
  isAccessibleForFree: true,
  keywords: [
    "llm spatial reasoning",
    "spatial reasoning benchmark",
    "voxel benchmark",
    "voxel bench",
    "voxelbench",
    "llm arena",
    "minecraft ai benchmark",
    "3d reasoning evaluation",
    "llm leaderboard",
    "private evals",
  ],
  creator: {
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
  },
  publisher: {
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
  },
  license: "https://opensource.org/licenses/MIT",
};

export function leaderboardItemListJsonLd(
  models: Array<{ name: string; rank: number; path: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "MineBench AI Spatial Reasoning Leaderboard",
    description: "Live rankings of AI models on 3D voxel spatial reasoning tasks",
    itemListElement: models.map((model) => ({
      "@type": "ListItem",
      position: model.rank,
      name: model.name,
      url: absoluteUrl(model.path),
    })),
  };
}

export function modelDetailJsonLd(params: {
  key: string;
  slug?: string;
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
  const canonicalPath = `/leaderboard/${params.slug ?? params.key}`;

  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${params.displayName} stats | ${SITE_NAME}`,
    url: absoluteUrl(canonicalPath),
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
          name: "Rating",
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
