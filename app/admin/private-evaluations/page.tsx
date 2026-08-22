import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLabIdentity } from "@/lib/stealth/auth";
import {
  listStealthEvaluationWorkspaces,
  listStealthOrganizationsForAdmin,
} from "@/lib/stealth/service";
import {
  createAdminEvaluationAction,
  provisionOrganizationAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private Evaluations Admin",
  robots: { index: false, follow: false },
};

function label(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default async function PrivateEvaluationsAdminPage() {
  const identity = await getLabIdentity();
  if (!identity) redirect("/lab/sign-in");
  if (!identity.user.isMineBenchAdmin) notFound();
  const actor = { minebenchAdmin: true } as const;
  const organizations = await listStealthOrganizationsForAdmin(actor);
  const evaluations = new Map(
    await Promise.all(
      organizations.map(async (organization) => [
        organization.id,
        await listStealthEvaluationWorkspaces(actor, organization.id),
      ] as const),
    ),
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10 py-6 sm:py-12">
      <header className="border-b border-border/70 pb-7">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">MineBench</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Private evaluations
        </h1>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-fg">Approve organization</h2>
        <form action={provisionOrganizationAction} className="grid gap-3 border-y border-border/70 py-5 md:grid-cols-4">
          <input className="mb-field" name="name" aria-label="Organization name" placeholder="Organization" required />
          <input className="mb-field" name="slug" aria-label="Organization slug" placeholder="organization" required />
          <input className="mb-field" name="initialAdminEmail" type="email" aria-label="Initial Admin email" placeholder="admin@example.com" required />
          <button className="mb-btn mb-btn-primary" type="submit">Approve</button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-fg">Organizations</h2>
        <div className="divide-y divide-border/60 border-y border-border/70">
          {organizations.map((organization) => (
            <article key={organization.id} className="space-y-4 py-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-xl font-medium text-fg">{organization.name}</h3>
                  <p className="mt-1 text-sm text-muted">
                    {organization.memberCount} members · {organization.evaluationCount} evaluations
                  </p>
                </div>
                <form action={createAdminEvaluationAction.bind(null, organization.id)} className="flex gap-2">
                  <input className="mb-field h-10" name="name" aria-label={`New evaluation for ${organization.name}`} placeholder="Evaluation name" required />
                  <button className="mb-btn mb-btn-ghost h-10" type="submit">Create</button>
                </form>
              </div>
              <div className="divide-y divide-border/40 border-t border-border/50">
                {(evaluations.get(organization.id) ?? []).map((evaluation) => (
                  <Link
                    key={evaluation.id}
                    href={`/admin/private-evaluations/${evaluation.id}?organizationId=${encodeURIComponent(organization.id)}`}
                    className="grid gap-2 py-3 text-sm transition-colors hover:text-accent sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                  >
                    <span className="font-medium">{evaluation.name}</span>
                    <span className="text-muted">{evaluation.checkpointCount} checkpoints</span>
                    <span className="text-muted">{label(evaluation.status)}</span>
                  </Link>
                ))}
              </div>
            </article>
          ))}
          {organizations.length === 0 ? <p className="py-8 text-sm text-muted">No organizations</p> : null}
        </div>
      </section>
    </div>
  );
}
