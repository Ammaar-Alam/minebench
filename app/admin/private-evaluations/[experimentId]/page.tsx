import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ProtectedBuildInspector,
  type ProtectedBuildOption,
} from "@/components/lab/ProtectedBuildInspector";
import { getLabIdentity } from "@/lib/stealth/auth";
import { getStealthExperimentReport } from "@/lib/stealth/report";
import {
  getStealthEvaluationWorkspace,
  getStealthOrganizationForAdmin,
} from "@/lib/stealth/service";
import {
  activateAdminEvaluationAction,
  closeAdminEvaluationAction,
  disableAdminEndpointAction,
  pauseAdminEvaluationAction,
  resumeAdminEvaluationAction,
} from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evaluation Admin",
  robots: { index: false, follow: false },
};

function label(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default async function PrivateEvaluationAdminDetail({
  params,
  searchParams,
}: {
  params: Promise<{ experimentId: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const identity = await getLabIdentity();
  if (!identity) redirect("/lab/sign-in");
  if (!identity.user.isMineBenchAdmin) notFound();
  const { experimentId } = await params;
  const { organizationId } = await searchParams;
  if (!organizationId) notFound();
  const actor = { minebenchAdmin: true } as const;
  const [workspace, organization, report] = await Promise.all([
    getStealthEvaluationWorkspace(actor, organizationId, experimentId),
    getStealthOrganizationForAdmin(actor, organizationId),
    getStealthExperimentReport(experimentId),
  ]);
  if (!workspace || !organization || report?.organization.id !== organizationId) notFound();
  const builds: ProtectedBuildOption[] = report.variants.flatMap((variant) =>
    variant.builds.map((build) => ({
      id: `${variant.id}:${build.promptId}`,
      resultId: build.resultId,
      checkpointId: variant.id,
      checkpoint: variant.codename,
      promptId: build.promptId,
      prompt: build.prompt,
      status: build.status,
      error: build.error,
      blockCount: build.blockCount,
      attempts: build.attempts,
      generationTimeMs: build.generationTimeMs,
    })),
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-9 py-6 sm:py-12">
      <header className="space-y-5 border-b border-border/70 pb-7">
        <Link href="/admin/private-evaluations" className="text-sm text-muted transition hover:text-fg">← Private evaluations</Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm text-muted">{workspace.organization.name}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{workspace.name}</h1>
          </div>
          <span className="text-sm font-medium text-muted">{label(workspace.status)}</span>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-fg">Team</h2>
        <div className="divide-y divide-border/50 border-y border-border/70">
          {organization.memberships.map((membership) => (
            <div key={membership.email} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span className="truncate text-fg">{membership.displayName || membership.email}</span>
              <span className="text-muted">{label(membership.role)}</span>
            </div>
          ))}
          {organization.pendingInvitations.map((invitation) => (
            <div key={invitation.email} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span className="truncate text-muted">{invitation.email}</span>
              <span className="text-muted">Pending {label(invitation.role)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-fg">Checkpoints</h2>
        <div className="divide-y divide-border/50 border-y border-border/70">
          {workspace.checkpoints.map((checkpoint) => (
            <article key={checkpoint.id} className="space-y-3 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-medium text-fg">{checkpoint.codename}</h3>
                  <p className="mt-1 text-sm text-muted">
                    {label(checkpoint.source)} · {checkpoint.generatedBuildCount}/{checkpoint.expectedBuildCount} builds · {checkpoint.decisiveVotes} decisive votes
                  </p>
                </div>
                <span className="text-sm text-muted">{label(checkpoint.status)}</span>
              </div>
              <p className="text-sm text-muted">
                Credential {checkpoint.credentialConfigured ? "present" : "absent"}
                {checkpoint.latestGenerationRun ? ` · Run ${label(checkpoint.latestGenerationRun.status)} · ${checkpoint.latestGenerationRun.failedBuildCount} failed` : ""}
              </p>
              {checkpoint.credentialConfigured ? (
                <form action={disableAdminEndpointAction.bind(null, organizationId, experimentId, checkpoint.id)}>
                  <button className="mb-btn mb-btn-ghost h-9" type="submit">Disable endpoint</button>
                </form>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <ProtectedBuildInspector orgSlug={workspace.organization.slug} builds={builds} />

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-fg">Results</h2>
        <div className="divide-y divide-border/50 border-y border-border/70">
          {report.variants.map((variant) => (
            <div key={variant.id} className="grid gap-2 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <span className="font-medium text-fg">{variant.codename}</span>
              <span className="text-muted">#{variant.estimatedFieldRank} of {variant.estimatedFieldSize}</span>
              <span className="text-muted">{variant.outcomes.votes.toLocaleString()} votes</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-wrap gap-2 border-t border-border/70 pt-6">
        {workspace.status === "READY" ? (
          <form action={activateAdminEvaluationAction.bind(null, organizationId, experimentId)}><button className="mb-btn mb-btn-primary" type="submit">Activate</button></form>
        ) : null}
        {workspace.status === "ACTIVE" ? (
          <form action={pauseAdminEvaluationAction.bind(null, organizationId, experimentId)}><button className="mb-btn mb-btn-ghost" type="submit">Pause</button></form>
        ) : null}
        {workspace.status === "PAUSED" ? (
          <form action={resumeAdminEvaluationAction.bind(null, organizationId, experimentId)}><button className="mb-btn mb-btn-primary" type="submit">Resume</button></form>
        ) : null}
        {workspace.status !== "CLOSED" ? (
          <form action={closeAdminEvaluationAction.bind(null, organizationId, experimentId)}><button className="mb-btn mb-btn-ghost" type="submit">Close</button></form>
        ) : (
          <p className="text-sm text-muted">Retention until {workspace.retentionDeleteAt?.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) ?? "scheduled deletion"}</p>
        )}
      </section>
    </div>
  );
}
