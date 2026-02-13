import type { Metadata } from "next";
import { Sandbox } from "@/components/sandbox/Sandbox";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Sandbox",
  description:
    "Generate and compare AI voxel builds from custom prompts in the MineBench sandbox.",
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
      "Generate and compare AI voxel builds from custom prompts in the MineBench sandbox.",
    url: "/sandbox",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench sandbox voxel build generation" }],
  },
  twitter: {
    title: "MineBench Sandbox | AI Voxel Generator",
    description:
      "Generate and compare AI voxel builds from custom prompts in the MineBench sandbox.",
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
  const prompt = typeof promptParam === "string" ? promptParam : undefined;
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <h1 className="sr-only">MineBench sandbox for AI voxel builds</h1>
      <Sandbox initialPrompt={prompt} />
    </>
  );
}
