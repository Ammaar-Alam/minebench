import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { GalleryDetail } from "@/components/gallery/GalleryDetail";
import { ARENA_SESSION_COOKIE } from "@/lib/arena/session";
import { getGalleryCandidate } from "@/lib/gallery/service";
import { getCurrentAccount } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ publicId: string }> }): Promise<Metadata> {
  const candidate = await getGalleryCandidate((await params).publicId);
  if (!candidate) return { title: "Gallery prompt not found", robots: { index: false, follow: false } };
  const description = candidate.prompt.length > 155 ? `${candidate.prompt.slice(0, 152)}…` : candidate.prompt;
  return {
    title: candidate.prompt,
    description,
    alternates: { canonical: `/gallery/${candidate.id}` },
    openGraph: { title: candidate.prompt, description, url: `/gallery/${candidate.id}` },
  };
}

export default async function GalleryDetailPage({ params }: { params: Promise<{ publicId: string }> }) {
  const [cookieStore, account] = await Promise.all([cookies(), getCurrentAccount().catch(() => null)]);
  const candidate = await getGalleryCandidate((await params).publicId, {
    sessionId: cookieStore.get(ARENA_SESSION_COOKIE)?.value ?? null,
    userId: account?.id,
  });
  if (!candidate) notFound();
  return <GalleryDetail candidate={candidate} />;
}
