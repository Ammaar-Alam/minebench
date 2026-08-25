import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLabIdentity } from "@/lib/stealth/auth";
import { requestLabMagicLink } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function LabSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const identity = await getLabIdentity().catch(() => null);
  if (identity?.memberships[0]) redirect(`/lab/${identity.memberships[0].organization.slug}`);
  const params = await searchParams;

  return (
    <div className="mx-auto flex min-h-[62vh] w-full max-w-sm items-center py-10 sm:py-16">
      <section className="w-full space-y-7">
        <header className="space-y-2 border-b border-border/70 pb-6">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Sign in</h1>
          <p className="text-sm text-muted">Use your invited email.</p>
        </header>

        {params.sent === "1" ? (
          <p role="status" className="mb-feedback mb-feedback-status">
            Check your email for a sign-in link.
          </p>
        ) : null}
        {params.error ? (
          <p role="alert" className="mb-feedback mb-feedback-error">
            That link has expired. Request another.
          </p>
        ) : null}

        <form action={requestLabMagicLink} className="space-y-4">
          <label className="block space-y-2 text-sm font-medium text-fg">
            <span>Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mb-field h-12 text-base"
            />
          </label>
          <button type="submit" className="mb-btn mb-btn-primary h-11 w-full text-sm">
            Send link
          </button>
        </form>
      </section>
    </div>
  );
}
