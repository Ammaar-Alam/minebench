import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLabIdentity } from "@/lib/stealth/auth";
import { signOutLab } from "./sign-in/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Organizations",
  robots: { index: false, follow: false },
};

export default async function LabHomePage() {
  const identity = await getLabIdentity().catch(() => null);
  if (!identity) redirect("/lab/sign-in");
  if (identity.memberships.length === 1 && !identity.user.isMineBenchAdmin) {
    redirect(`/lab/${identity.memberships[0].organization.slug}`);
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 py-6 sm:py-12">
      <header className="flex items-center justify-between gap-4 border-b border-border/70 pb-5">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Organizations</h1>
        <div className="flex items-center gap-3">
          {identity.user.isMineBenchAdmin ? (
            <Link
              href="/admin/private-evaluations"
              className="mb-btn mb-btn-primary min-h-11 px-4 text-xs"
            >
              Admin workspace
            </Link>
          ) : null}
          <form action={signOutLab}>
            <button type="submit" className="mb-btn mb-btn-ghost min-h-11 px-4 text-xs">Sign out</button>
          </form>
        </div>
      </header>

      {identity.memberships.length > 0 ? (
        <div className="divide-y divide-border/60 border-y border-border/70">
          {identity.memberships.map(({ organization }) => (
            <Link
              key={organization.id}
              href={`/lab/${organization.slug}`}
              className="group flex items-center justify-between gap-6 py-5 transition-colors hover:text-accent"
            >
              <h2 className="text-lg font-medium tracking-tight text-fg transition-colors group-hover:text-accent">
                {organization.name}
              </h2>
              <span aria-hidden="true" className="text-muted">
                →
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <section className="border-y border-border/70 py-8 space-y-4">
          <h2 className="text-lg font-medium tracking-tight text-fg">No organizations</h2>
          <p className="text-sm text-muted">
            {identity.user.isMineBenchAdmin
              ? "You are logged in as a MineBench administrator. Go to the admin workspace to approve organizations."
              : "This account has no active invitation."}
          </p>
          {identity.user.isMineBenchAdmin ? (
            <Link
              href="/admin/private-evaluations"
              className="mb-btn mb-btn-primary inline-flex text-sm"
            >
              Go to Admin workspace
            </Link>
          ) : null}
        </section>
      )}
    </div>
  );
}
