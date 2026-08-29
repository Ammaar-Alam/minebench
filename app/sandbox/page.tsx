import type { Metadata } from "next";
import { Sandbox } from "@/components/sandbox/Sandbox";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE } from "@/lib/seo";
import { getCurrentAccount } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sandbox",
  description:
    "Compare, generate, and import AI voxel builds in the MineBench sandbox.",
  keywords: [
    "ai voxel generator",
    "voxel build generator",
    "minecraft ai build generator",
    "llm spatial reasoning",
  ],
  alternates: {
    canonical: "/sandbox",
  },
  openGraph: {
    title: "MineBench Sandbox | AI Voxel Generator",
    description:
      "Compare, generate, and import AI voxel builds in the MineBench sandbox.",
    url: "/sandbox",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench sandbox voxel build generation" }],
  },
  twitter: {
    title: "MineBench Sandbox | AI Voxel Generator",
    description:
      "Compare, generate, and import AI voxel builds in the MineBench sandbox.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Sandbox", path: "/sandbox" },
]);

export default async function SandboxPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = (await searchParams) ?? {};
  const promptParam = sp.prompt;
  const hasComparisonState = sp.models !== undefined || sp.promptId !== undefined;
  const prompt =
    !hasComparisonState && typeof promptParam === "string" ? promptParam : undefined;
  const account = await getCurrentAccount().catch(() => null);
  const anonymousServerKeysEnabled =
    process.env.NODE_ENV !== "production" ||
    process.env.MINEBENCH_ALLOW_SERVER_KEYS === "1";
  const hostedGeminiEnabled = Boolean(
    process.env.MINEBENCH_FREE_OPENROUTER_API_KEY?.trim(),
  );
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <h1 className="sr-only">MineBench sandbox for AI voxel builds</h1>
      <Sandbox
        initialPrompt={prompt}
        signedIn={Boolean(account)}
        anonymousServerKeysEnabled={anonymousServerKeysEnabled}
        hostedGeminiEnabled={hostedGeminiEnabled}
        hostedGeminiAvailable={Boolean(
          account &&
          hostedGeminiEnabled &&
          account.hostedGenerationCount < account.hostedGenerationLimit
        )}
        hasPublicNickname={Boolean(account?.publicNickname)}
        gallerySuspended={Boolean(account?.gallerySuspendedAt)}
      />
    </>
  );
}
