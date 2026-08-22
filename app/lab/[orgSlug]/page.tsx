import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { formatDateTime, titleCase } from "@/components/lab/format";
import { prisma } from "@/lib/prisma";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { listStealthEvaluationWorkspaces } from "@/lib/stealth/service";
import { inviteMemberAction, removeMemberAction, updateMemberRoleAction } from "./actions";
import { signOutLab } from "../sign-in/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evaluations",
  robots: { index: false, follow: false },
};

export default async function LabOrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) redirect("/lab/sign-in");

  const organizationId = context.membership.organization.id;
  const [evaluations, team] = await Promise.all([
    listStealthEvaluationWorkspaces(
      { organizationUser: { userId: context.user.id } },
      organizationId,
    ),
    context.membership.role === "ADMIN"
      ? prisma.organization.findUnique({
          where: { id: organizationId },
          select: {
            memberships: {
              orderBy: [{ role: "asc" }, { user: { email: "asc" } }],
              select: {
                role: true,
                user: { select: { id: true, email: true, displayName: true } },
              },
            },
            invitations: {
              where: { acceptedAt: null, revokedAt: null },
              orderBy: { email: "asc" },
              select: { id: true, email: true, role: true },
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const inviteAction = inviteMemberAction.bind(null, orgSlug);
  const removeAction = removeMemberAction.bind(null, orgSlug);
  const updateRoleAction = updateMemberRoleAction.bind(null, orgSlug);

  return (
    <div className="mx-auto w-full max-w-[72rem] space-y-12 py-5 sm:py-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs text-muted">{titleCase(context.membership.role)}</p>
          <h1 className="mt-2 truncate text-3xl font-semibold tracking-tight text-fg">
            {context.membership.organization.name}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/lab/${orgSlug}/new`} className="mb-btn mb-btn-primary min-h-11 px-5">
            New evaluation
          </Link>
          {context.memberships.length > 1 ? (
            <Link href="/lab" className="mb-btn mb-btn-ghost min-h-11 px-4 text-xs">
              Organizations
            </Link>
          ) : null}
          <form action={signOutLab}>
            <button type="submit" className="mb-btn mb-btn-ghost min-h-11 px-4 text-xs">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section aria-labelledby="evaluations-heading">
        <div className="flex items-baseline justify-between gap-4 pb-4">
          <h2 id="evaluations-heading" className="text-lg font-semibold tracking-tight text-fg">
            Evaluations
          </h2>
          <span className="font-mono text-xs tabular-nums text-muted">{evaluations.length}</span>
        </div>

        {evaluations.length > 0 ? (
          <div className="border-y border-border/70">
            <div className="hidden grid-cols-[minmax(0,1fr)_12rem_8rem_1.5rem] gap-6 border-b border-border/55 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted2 sm:grid">
              <span>Evaluation</span>
              <span>Builds</span>
              <span className="text-right">Votes</span>
              <span />
            </div>
            {evaluations.map((evaluation) => {
              const buildPercent = evaluation.buildProgress.expected
                ? Math.min(
                    100,
                    Math.round(
                      (evaluation.buildProgress.completed / evaluation.buildProgress.expected) * 100,
                    ),
                  )
                : 0;

              return (
                <Link
                  key={evaluation.id}
                  href={`/lab/${orgSlug}/experiments/${evaluation.id}`}
                  className="group grid min-h-24 gap-4 border-b border-border/50 py-5 transition-colors last:border-0 hover:bg-card/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:grid-cols-[minmax(0,1fr)_12rem_8rem_1.5rem] sm:items-center sm:gap-6"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="truncate text-lg font-medium tracking-tight text-fg group-hover:text-accent">
                        {evaluation.name}
                      </h3>
                      <EvaluationStatus status={evaluation.status} />
                    </div>
                    <p className="mt-1.5 text-xs text-muted">
                      {evaluation.checkpointCount} {evaluation.checkpointCount === 1 ? "checkpoint" : "checkpoints"}
                      <span className="mx-2 text-border">·</span>
                      {formatDateTime(evaluation.updatedAt)}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-3 font-mono text-xs tabular-nums text-muted sm:hidden">
                      <span>Builds</span>
                      <span className="text-fg">{evaluation.buildProgress.completed}/{evaluation.buildProgress.expected}</span>
                    </div>
                    <div className="hidden justify-end font-mono text-xs tabular-nums text-fg sm:flex">
                      {evaluation.buildProgress.completed}/{evaluation.buildProgress.expected}
                    </div>
                    <div className="mt-2 h-px bg-border/60">
                      <div className="h-px bg-accent" style={{ width: `${buildPercent}%` }} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs sm:block sm:text-right">
                    <span className="text-muted sm:hidden">Votes</span>
                    <span className="font-mono tabular-nums text-fg">
                      {evaluation.voteProgress.decisiveVotes.toLocaleString()}
                    </span>
                  </div>
                  <span aria-hidden="true" className="hidden text-right text-muted group-hover:text-fg sm:block">→</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="border-y border-border/70 py-10">
            <p className="text-sm text-muted">No evaluations</p>
            <Link href={`/lab/${orgSlug}/new`} className="mt-4 inline-flex text-sm font-medium text-accent hover:underline">
              New evaluation
            </Link>
          </div>
        )}
      </section>

      {team ? (
        <details className="group border-y border-border/70">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
            <span className="text-sm font-medium text-fg">
              Team <span className="ml-2 font-normal text-muted">{team.memberships.length}</span>
            </span>
            <span aria-hidden="true" className="text-lg text-muted transition-transform group-open:rotate-45 motion-reduce:transition-none">+</span>
          </summary>
          <div className="space-y-7 border-t border-border/55 py-6">
            <form action={inviteAction} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Email</span>
                <input name="email" type="email" required autoComplete="email" className="mb-field h-11" />
              </label>
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Role</span>
                <select name="role" defaultValue="MEMBER" className="mb-field h-11">
                  <option value="MEMBER">Member</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </label>
              <button type="submit" className="mb-btn mb-btn-primary min-h-11 self-end px-5">Invite</button>
            </form>

            <div className="divide-y divide-border/50 border-y border-border/55">
              {team.memberships.map(({ user, role }) => (
                <div key={user.id} className="flex min-h-14 flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-fg">{user.displayName || user.email}</div>
                    {user.displayName ? <div className="truncate text-xs text-muted">{user.email}</div> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                    {user.id !== context.user.id ? (
                      <>
                        <form action={updateRoleAction} className="flex items-center gap-2">
                          <input type="hidden" name="email" value={user.email} />
                          <select name="role" defaultValue={role} aria-label={`Role for ${user.email}`} className="mb-field h-11 w-28 text-xs">
                            <option value="MEMBER">Member</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                          <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-fg">Update</button>
                        </form>
                        <form action={removeAction}>
                          <input type="hidden" name="email" value={user.email} />
                          <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-danger">Remove</button>
                        </form>
                      </>
                    ) : (
                      <span className="text-xs text-muted">{titleCase(role)}</span>
                    )}
                  </div>
                </div>
              ))}
              {team.invitations.map((invitation) => (
                <div key={invitation.id} className="flex min-h-14 flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-fg">{invitation.email}</div>
                    <div className="text-xs text-muted">Pending</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <form action={updateRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="email" value={invitation.email} />
                      <select name="role" defaultValue={invitation.role} aria-label={`Role for ${invitation.email}`} className="mb-field h-11 w-28 text-xs">
                        <option value="MEMBER">Member</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                      <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-fg">Update</button>
                    </form>
                    <form action={removeAction}>
                      <input type="hidden" name="email" value={invitation.email} />
                      <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-danger">Revoke</button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
