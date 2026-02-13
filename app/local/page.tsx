import type { Metadata } from "next";
import { LocalLab } from "@/components/local/LocalLab";
import { breadcrumbJsonLd } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Local",
  description:
    "Run MineBench prompts with your own model setup and validate voxel JSON output locally.",
  alternates: {
    canonical: "/local",
  },
  robots: {
    index: false,
    follow: false,
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Local Lab", path: "/local" },
]);

export default function LocalLabPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <h1 className="sr-only">MineBench local lab</h1>
      <LocalLab />
    </>
  );
}
