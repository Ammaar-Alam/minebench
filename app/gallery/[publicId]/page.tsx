import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { GalleryDetail } from "@/components/gallery/GalleryDetail";
import { ARENA_SESSION_COOKIE } from "@/lib/arena/session";
import { getGalleryCandidate, normalizeGallerySort } from "@/lib/gallery/service";
import { getCurrentAccount } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

type GalleryPageProps = {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ sort?: string }>;
};

const loadCandidate = cache(async (publicId: string, sort: ReturnType<typeof normalizeGallerySort>) => {
  const [cookieStore, account] = await Promise.all([
    cookies(),
    getCurrentAccount().catch(() => null),
  ]);
  return getGalleryCandidate(publicId, {
    sessionId: cookieStore.get(ARENA_SESSION_COOKIE)?.value ?? null,
    userId: account?.id,
    navigationSort: sort,
  });
});

export async function generateMetadata({ params, searchParams }: GalleryPageProps): Promise<Metadata> {
  const [route, query] = await Promise.all([params, searchParams]);
  const candidate = await loadCandidate(route.publicId, normalizeGallerySort(query.sort));
  if (!candidate) return { title: "Gallery prompt not found", robots: { index: false, follow: false } };
  const description = candidate.prompt.length > 155 ? `${candidate.prompt.slice(0, 152)}…` : candidate.prompt;
  return {
    title: candidate.prompt,
    description,
    alternates: { canonical: `/gallery/${candidate.id}` },
    openGraph: { title: candidate.prompt, description, url: `/gallery/${candidate.id}` },
  };
}

export default async function GalleryDetailPage({
  params,
  searchParams,
}: GalleryPageProps) {
  const [route, query] = await Promise.all([params, searchParams]);
  const candidate = await loadCandidate(route.publicId, normalizeGallerySort(query.sort));
  if (!candidate) notFound();
  return <GalleryDetail candidate={candidate} />;
}
