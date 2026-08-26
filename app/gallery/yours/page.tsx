import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GalleryYours } from "@/components/gallery/GalleryYours";
import { getCurrentAccount } from "@/lib/auth/account";
import { listSavedGenerations } from "@/lib/generations/service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your Gallery",
  robots: { index: false, follow: false },
};

export default async function GalleryYoursPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/sign-in?next=/gallery/yours");
  const page = await listSavedGenerations(account.id);
  return <GalleryYours initialItems={page.items} initialCursor={page.nextCursor} hasNickname={Boolean(account.publicNickname)} suspended={Boolean(account.gallerySuspendedAt)} />;
}
