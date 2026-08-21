import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLabIdentity } from "@/lib/stealth/auth";
import { signOutLab } from "./sign-in/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private evaluations",
  robots: { index: false, follow: false },
};

export default async function LabHomePage() {
  const identity = await getLabIdentity().catch(() => null);
  if (!identity) redirect("/lab/sign-in");
  if (identity.memberships.length === 1) {
    redirect(`/lab/${identity.memberships[0].organization.slug}`);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 py-6 sm:py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <span className="mb-eyebrow">Private evaluations</span>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-fg">Organizations</h1>
        </div>
        <form action={signOutLab}>
          <button type="submit" className="mb-btn mb-btn-ghost h-9 px-4 text-xs">Sign out</button>
        </form>
      </header>

      {identity.memberships.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {identity.memberships.map(({ organization, role }) => (
            <Link
              key={organization.id}
              href={`/lab/${organization.slug}`}
              className="mb-panel overflow-hidden p-5 before:hidden transition hover:border-accent/35"
            >
              <div className="mb-panel-inner space-y-2">
                <h2 className="font-display text-lg font-semibold tracking-tight text-fg">{organization.name}</h2>
                <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted">{role.toLowerCase()}</p>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <section className="mb-panel p-5 before:hidden sm:p-7">
          <div className="mb-panel-inner space-y-3">
            <h2 className="font-display text-xl font-semibold tracking-tight">Access pending</h2>
            <p className="max-w-[55ch] text-sm leading-relaxed text-muted">
              This account is signed in but has not been added to an evaluation organization.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
