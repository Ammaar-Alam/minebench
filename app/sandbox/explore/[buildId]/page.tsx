import type { Metadata } from "next";
import { VoxelExplorer } from "@/components/voxel/VoxelExplorer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Explore Build",
  robots: { index: false, follow: false },
};

export default async function SandboxExplorePage({
  params,
}: {
  params: Promise<{ buildId: string }>;
}) {
  const { buildId } = await params;
  return <VoxelExplorer buildId={buildId} />;
}
