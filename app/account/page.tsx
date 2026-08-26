import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signOutAccount } from "@/app/(auth)/actions";
import { GalleryYours } from "@/components/gallery/GalleryYours";
import { getCurrentAccount } from "@/lib/auth/account";
import { listSavedGenerations } from "@/lib/generations/service";
import { PersonalRanking, PersonalRankingSkeleton } from "./PersonalRanking";
import { GalleryAccountSettings } from "./GalleryAccountSettings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account",
  robots: { index: false, follow: false },
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const account = await getCurrentAccount();
  if (!account) redirect("/sign-in?next=/account");
  const [params, generations] = await Promise.all([
    searchParams,
    listSavedGenerations(account.id),
  ]);

  return (
    <div className="mb-fade-in mx-auto w-full max-w-7xl space-y-10 py-4 sm:py-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-fg sm:text-5xl">Account</h1>
        <Link href="/" className="mb-btn mb-btn-primary h-11 self-start sm:self-auto">
          Keep voting
        </Link>
      </header>

      {params.notice === "password" ? (
        <p role="status" className="mb-feedback mb-feedback-status">
          Password updated.
        </p>
      ) : null}
      {params.notice === "created" ? (
        <p role="status" className="mb-feedback mb-feedback-status">
          Account created.
        </p>
      ) : null}
      {params.notice === "password-email" ? (
        <p role="status" className="mb-feedback mb-feedback-status">
          Check your email to set a password.
        </p>
      ) : null}

      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start xl:gap-16">
        <div className="min-w-0 space-y-12">
          <section className="space-y-4" aria-labelledby="ranking-title">
            <h2 id="ranking-title" className="text-xl font-semibold tracking-tight text-fg">
              Your ranking
            </h2>
            <Suspense fallback={<PersonalRankingSkeleton />}>
              <PersonalRanking userId={account.id} />
            </Suspense>
          </section>

          <GalleryYours
            initialItems={generations.items}
            initialCursor={generations.nextCursor}
            hasNickname={Boolean(account.publicNickname)}
            suspended={Boolean(account.gallerySuspendedAt)}
          />
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24">
          <GalleryAccountSettings
            publicNickname={account.publicNickname}
            suspendedAt={account.gallerySuspendedAt?.toISOString() ?? null}
            suspensionReason={account.gallerySuspensionReason}
          />

          <section className="rounded-md border border-border/80 bg-card/10 p-5" aria-labelledby="security-title">
            <p className="mb-eyebrow">Account</p>
            <h2 id="security-title" className="mt-2 text-lg font-semibold tracking-tight text-fg">
              Security
            </h2>
            <dl className="mt-5 space-y-4 text-sm">
              <div className="space-y-1">
                <dt className="text-muted">Email</dt>
                <dd className="break-all text-fg">{account.email}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted">Joined</dt>
                <dd className="text-fg">
                  {new Intl.DateTimeFormat("en-US", {
                    month: "long",
                    year: "numeric",
                  }).format(account.createdAt)}
                </dd>
              </div>
            </dl>
            <div className="mt-5 space-y-2 border-t border-border pt-5">
              <Link href="/reset-password" className="mb-btn mb-btn-ghost h-10 w-full">
                Change password
              </Link>
              <form action={signOutAccount}>
                <button type="submit" className="mb-btn h-10 w-full text-muted hover:text-fg">
                  Sign out
                </button>
              </form>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
