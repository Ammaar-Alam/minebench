import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CustomBuildPage } from "@/components/custom-builds/CustomBuildPage";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { getCustomBuildStatusPayload } from "@/lib/custom-builds/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Private build",
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

export default async function CustomBuildRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomBuildPublicId(id)) notFound();

  const status = await getCustomBuildStatusPayload(id);
  if (!status) notFound();

  return <CustomBuildPage initialStatus={status} />;
}
