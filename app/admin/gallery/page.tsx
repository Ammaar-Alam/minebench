import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth/account";
import { getGalleryAdminDashboard } from "@/lib/gallery/service";
import { GalleryAdminDashboard } from "@/components/gallery/GalleryAdminDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gallery Admin",
  robots: { index: false, follow: false },
};

export default async function GalleryAdminPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/sign-in?next=/admin/gallery");
  if (!account.isMineBenchAdmin) notFound();
  const dashboard = await getGalleryAdminDashboard(account.id);

  return (
    <div className="mx-auto w-full max-w-[92rem] space-y-8 py-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="mb-eyebrow">MineBench</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Gallery admin</h1>
        </div>
        <Link href="/gallery" className="mb-btn h-10">Open Gallery</Link>
      </header>
      <GalleryAdminDashboard dashboard={dashboard} />
    </div>
  );
}
