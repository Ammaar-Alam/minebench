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
    <div className="mx-auto w-full max-w-6xl space-y-12 py-6 sm:py-12">
      <header className="flex flex-col gap-5 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="truncate text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            {context.membership.organization.name}
          </h1>
          <p className="text-xs text-muted">{titleCase(context.membership.role)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/lab/${orgSlug}/new`} className="mb-btn mb-btn-primary min-h-11 px-4 text-sm">
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

      <section className="space-y-3" aria-labelledby="evaluations-heading">
        <div className="flex items-center justify-between gap-4">
          <h2 id="evaluations-heading" className="text-sm font-medium text-muted">
            Evaluations
          </h2>
          <span className="font-mono text-xs tabular-nums text-muted">{evaluations.length}</span>
        </div>

        {evaluations.length > 0 ? (
          <div className="divide-y divide-border/60 border-y border-border/70">
            {evaluations.map((evaluation) => (
              <Link
                key={evaluation.id}
                href={`/lab/${orgSlug}/experiments/${evaluation.id}`}
                className="group grid min-h-11 gap-4 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0 space-y-1.5">
                  <h3 className="truncate text-xl font-medium tracking-tight text-fg transition-colors group-hover:text-accent">
                    {evaluation.name}
                  </h3>
                  <p className="text-xs text-muted">Updated {formatDateTime(evaluation.updatedAt)}</p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:flex sm:items-center sm:justify-end">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.08em] text-muted">Checkpoints</div>
                    <div className="mt-1 font-mono text-xs tabular-nums text-fg">
                      {evaluation.checkpointCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.08em] text-muted">Builds</div>
                    <div className="mt-1 font-mono text-xs tabular-nums text-fg">
                      {evaluation.buildProgress.completed}/{evaluation.buildProgress.expected}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.08em] text-muted">Votes</div>
                    <div className="mt-1 font-mono text-xs tabular-nums text-fg">
                      {evaluation.voteProgress.decisiveVotes.toLocaleString()}
                      {evaluation.voteProgress.targetDecisiveVotes
                        ? `/${evaluation.voteProgress.targetDecisiveVotes.toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                  <div className="self-end sm:self-auto">
                    <EvaluationStatus status={evaluation.status} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="border-y border-border/70 py-8">
            <h3 className="text-lg font-medium tracking-tight text-fg">No evaluations</h3>
            <Link href={`/lab/${orgSlug}/new`} className="mt-4 inline-flex text-sm text-accent hover:underline">
              Start an evaluation
            </Link>
          </div>
        )}
      </section>

      {team ? (
        <section className="space-y-5" aria-labelledby="team-heading">
          <div className="border-b border-border/70 pb-3">
            <h2 id="team-heading" className="text-xl font-semibold tracking-tight text-fg">
              Team
            </h2>
          </div>

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
            <button type="submit" className="mb-btn mb-btn-primary min-h-11 self-end px-5 text-sm">
              Invite
            </button>
          </form>

          <div className="divide-y divide-border/55 border-y border-border/70">
            {team.memberships.map(({ user, role }) => (
              <div key={user.id} className="flex min-h-14 items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">
                    {user.displayName || user.email}
                  </div>
                  {user.displayName ? <div className="truncate text-xs text-muted">{user.email}</div> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                  <span className="text-xs text-muted">{titleCase(role)}</span>
                  {user.id !== context.user.id ? (
                    <>
                      <form action={updateRoleAction} className="flex items-center gap-2">
                        <input type="hidden" name="email" value={user.email} />
                        <select
                          name="role"
                          defaultValue={role}
                          aria-label={`Role for ${user.email}`}
                          className="mb-field h-11 w-28 text-xs"
                        >
                          <option value="MEMBER">Member</option>
                          <option value="ADMIN">Admin</option>
                        </select>
                        <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-fg">
                          Update
                        </button>
                      </form>
                      <form action={removeAction}>
                        <input type="hidden" name="email" value={user.email} />
                        <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-danger">
                          Remove
                        </button>
                      </form>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
            {team.invitations.map((invitation) => (
              <div key={invitation.id} className="flex min-h-14 items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-fg">{invitation.email}</div>
                  <div className="text-xs text-muted">Invited</div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <form action={updateRoleAction} className="flex items-center gap-2">
                    <input type="hidden" name="email" value={invitation.email} />
                    <select
                      name="role"
                      defaultValue={invitation.role}
                      aria-label={`Role for ${invitation.email}`}
                      className="mb-field h-11 w-28 text-xs"
                    >
                      <option value="MEMBER">Member</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                    <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-fg">
                      Update
                    </button>
                  </form>
                  <form action={removeAction}>
                    <input type="hidden" name="email" value={invitation.email} />
                    <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-danger">
                      Revoke
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
