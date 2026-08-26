import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signOutAccount } from "@/app/(auth)/actions";
import { getCurrentAccount } from "@/lib/auth/account";
import { PersonalRanking, PersonalRankingSkeleton } from "./PersonalRanking";
import { GalleryAccountSettings } from "./GalleryAccountSettings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your rankings",
  robots: { index: false, follow: false },
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const account = await getCurrentAccount();
  if (!account) redirect("/sign-in?next=/account");
  const params = await searchParams;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10 py-4 sm:py-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <p className="mb-eyebrow">Account</p>
          <h1 className="font-display text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
            Your rankings
          </h1>
          <p className="text-sm text-muted">What you tend to prefer.</p>
        </div>
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

      <section className="space-y-4" aria-labelledby="ranking-title">
        <h2 id="ranking-title" className="text-xl font-semibold tracking-tight text-fg">
          Your ranking
        </h2>
        <Suspense fallback={<PersonalRankingSkeleton />}>
          <PersonalRanking userId={account.id} />
        </Suspense>
      </section>

      <GalleryAccountSettings
        publicNickname={account.publicNickname}
        suspendedAt={account.gallerySuspendedAt?.toISOString() ?? null}
        suspensionReason={account.gallerySuspensionReason}
      />

      <section
        className="grid gap-7 border-t border-border pt-8 lg:grid-cols-[minmax(0,1fr)_18rem]"
        aria-labelledby="security-title"
      >
        <div>
          <p className="mb-eyebrow">Account</p>
          <h2 id="security-title" className="mt-2 text-xl font-semibold tracking-tight text-fg">
            Security
          </h2>
          <dl className="mt-5 grid gap-5 text-sm sm:grid-cols-2">
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
        </div>
        <div className="space-y-2 lg:self-end">
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
    </div>
  );
}
