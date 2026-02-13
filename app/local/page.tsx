import type { Metadata } from "next";
import { LocalLab } from "@/components/local/LocalLab";

export const metadata: Metadata = {
  title: "Local Lab",
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

export default function LocalLabPage() {
  return (
    <>
      <h1 className="sr-only">MineBench local lab</h1>
      <LocalLab />
    </>
  );
}
