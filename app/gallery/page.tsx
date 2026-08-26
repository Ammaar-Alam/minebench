import type { Metadata } from "next";
import { cookies } from "next/headers";
import { GalleryExplore } from "@/components/gallery/GalleryExplore";
import { ARENA_SESSION_COOKIE } from "@/lib/arena/session";
import { getCurrentAccount } from "@/lib/auth/account";
import { listGalleryCandidates } from "@/lib/gallery/service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gallery",
  description: "Explore prompts and AI-built worlds from the MineBench community.",
  alternates: { canonical: "/gallery" },
  openGraph: {
    title: "MineBench Gallery",
    description: "Explore prompts and AI-built worlds from the MineBench community.",
    url: "/gallery",
  },
};

export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const sort = (await searchParams).sort === "new" ? "new" : "top";
  const [cookieStore, account] = await Promise.all([
    cookies(),
    getCurrentAccount().catch(() => null),
  ]);
  const page = await listGalleryCandidates({
    sort,
    sessionId: cookieStore.get(ARENA_SESSION_COOKIE)?.value ?? null,
    userId: account?.id,
  });
  return (
    <GalleryExplore
      initialItems={page.items}
      initialCursor={page.nextCursor}
      sort={sort}
      signedIn={Boolean(account)}
      hasNickname={Boolean(account?.publicNickname)}
      suspended={Boolean(account?.gallerySuspendedAt)}
    />
  );
}
