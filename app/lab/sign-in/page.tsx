import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLabIdentity } from "@/lib/stealth/auth";
import { requestLabMagicLink } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evaluation access",
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
    <div className="mx-auto flex min-h-[62vh] w-full max-w-lg items-center py-8 sm:py-14">
      <section className="mb-panel w-full overflow-hidden p-5 before:hidden sm:p-7">
        <div className="mb-panel-inner space-y-6">
          <div className="space-y-3">
            <span className="mb-eyebrow">Private evaluations</span>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              Lab access
            </h1>
            <p className="max-w-[42ch] text-sm leading-relaxed text-muted sm:text-base">
              Sign in with an invited email to view active evaluations and results.
            </p>
          </div>

          {params.sent === "1" ? (
            <div className="rounded-xl border border-accent/25 bg-accent/8 px-4 py-3 text-sm leading-relaxed text-fg">
              If that address has access, a sign-in link is on its way.
            </div>
          ) : null}
          {params.error ? (
            <div className="rounded-xl border border-danger/25 bg-danger/8 px-4 py-3 text-sm leading-relaxed text-fg">
              That sign-in link is invalid or expired. Request a new one.
            </div>
          ) : null}

          <form action={requestLabMagicLink} className="space-y-3">
            <label className="block space-y-2 text-sm font-medium text-fg">
              <span>Email</span>
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                className="h-12 w-full rounded-xl border border-border/75 bg-bg/55 px-4 text-base text-fg outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              />
            </label>
            <button type="submit" className="mb-btn mb-btn-primary h-11 w-full text-sm">
              Send link
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
