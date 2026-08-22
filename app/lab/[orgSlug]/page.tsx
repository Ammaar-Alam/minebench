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
  const openEvaluations = evaluations.filter((evaluation) => evaluation.status !== "CLOSED").length;
  const totalBuilds = evaluations.reduce(
    (total, evaluation) => total + evaluation.buildProgress.completed,
    0,
  );
  const totalExpectedBuilds = evaluations.reduce(
    (total, evaluation) => total + evaluation.buildProgress.expected,
    0,
  );
  const totalVotes = evaluations.reduce(
    (total, evaluation) => total + evaluation.voteProgress.decisiveVotes,
    0,
  );

  return (
    <div className="mx-auto w-full max-w-[86rem] space-y-9 py-5 sm:py-10">
      <header className="overflow-hidden rounded-3xl border border-border/70 bg-card/60 shadow-soft">
        <div className="grid gap-7 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="mb-eyebrow">Private lab</span>
              <span className="text-xs text-muted">{titleCase(context.membership.role)}</span>
            </div>
            <h1 className="mt-4 truncate font-display text-3xl font-semibold tracking-[-0.04em] text-fg sm:text-4xl">
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
        </div>
        <dl className="grid grid-cols-3 divide-x divide-border/60 border-t border-border/60 bg-bg/30">
          <div className="p-4 sm:px-7 sm:py-5">
            <dt className="text-[10px] uppercase tracking-[0.12em] text-muted2">Open</dt>
            <dd className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">{openEvaluations}</dd>
          </div>
          <div className="p-4 sm:px-7 sm:py-5">
            <dt className="text-[10px] uppercase tracking-[0.12em] text-muted2">Builds</dt>
            <dd className="mt-1.5 font-mono text-base tabular-nums text-fg">
              {totalBuilds}/{totalExpectedBuilds}
            </dd>
          </div>
          <div className="p-4 sm:px-7 sm:py-5">
            <dt className="text-[10px] uppercase tracking-[0.12em] text-muted2">Votes</dt>
            <dd className="mt-1.5 text-2xl font-semibold tabular-nums text-fg">
              {totalVotes.toLocaleString()}
            </dd>
          </div>
        </dl>
      </header>

      <section className="space-y-4" aria-labelledby="evaluations-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="mb-eyebrow">Portfolio</p>
            <h2 id="evaluations-heading" className="mt-1.5 text-xl font-semibold tracking-tight text-fg">
              Evaluations
            </h2>
          </div>
          <span className="font-mono text-xs tabular-nums text-muted">{evaluations.length}</span>
        </div>

        {evaluations.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {evaluations.map((evaluation) => {
              const buildPercent = evaluation.buildProgress.expected
                ? Math.min(
                    100,
                    Math.round(
                      (evaluation.buildProgress.completed / evaluation.buildProgress.expected) * 100,
                    ),
                  )
                : 0;
              const voteTarget = evaluation.voteProgress.targetDecisiveVotes
                ? evaluation.voteProgress.targetDecisiveVotes * Math.max(1, evaluation.checkpointCount)
                : null;
              const votePercent = voteTarget
                ? Math.min(100, Math.round((evaluation.voteProgress.decisiveVotes / voteTarget) * 100))
                : 0;

              return (
                <Link
                  key={evaluation.id}
                  href={`/lab/${orgSlug}/experiments/${evaluation.id}`}
                  className="group rounded-3xl border border-border/70 bg-card/45 p-5 shadow-soft transition duration-200 hover:-translate-y-0.5 hover:border-accent/35 hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 motion-reduce:transform-none motion-reduce:transition-none sm:p-6"
                >
                  <div className="flex items-start justify-between gap-4">
                    <EvaluationStatus status={evaluation.status} />
                    <span className="text-[10px] text-muted2">
                      Updated {formatDateTime(evaluation.updatedAt)}
                    </span>
                  </div>
                  <div className="mt-5 flex items-end justify-between gap-4">
                    <h3 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-fg transition-colors group-hover:text-accent">
                      {evaluation.name}
                    </h3>
                    <span aria-hidden="true" className="shrink-0 text-lg text-muted transition group-hover:translate-x-1 group-hover:text-accent motion-reduce:transform-none motion-reduce:transition-none">
                      →
                    </span>
                  </div>
                  <div className="mt-7 grid gap-5 sm:grid-cols-2">
                    <div>
                      <div className="flex items-center justify-between gap-3 text-xs text-muted">
                        <span>Builds</span>
                        <span className="font-mono tabular-nums text-fg">
                          {evaluation.buildProgress.completed}/{evaluation.buildProgress.expected}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/45">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${buildPercent}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between gap-3 text-xs text-muted">
                        <span>Evidence</span>
                        <span className="font-mono tabular-nums text-fg">
                          {evaluation.voteProgress.decisiveVotes.toLocaleString()}
                          {voteTarget ? `/${voteTarget.toLocaleString()}` : ""}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/45">
                        <div
                          className={`h-full rounded-full ${voteTarget ? "bg-accent2" : "bg-muted2/50"}`}
                          style={{ width: voteTarget ? `${votePercent}%` : evaluation.voteProgress.decisiveVotes > 0 ? "100%" : "0%" }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mt-5 border-t border-border/55 pt-4 text-xs text-muted">
                    {evaluation.checkpointCount} {evaluation.checkpointCount === 1 ? "checkpoint" : "checkpoints"}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-border bg-card/30 p-8 sm:p-10">
            <h3 className="text-xl font-semibold tracking-tight text-fg">Start with a checkpoint</h3>
            <Link href={`/lab/${orgSlug}/new`} className="mt-5 inline-flex text-sm font-medium text-accent hover:underline">
              New evaluation →
            </Link>
          </div>
        )}
      </section>

      {team ? (
        <details className="group overflow-hidden rounded-3xl border border-border/70 bg-card/40">
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 sm:px-6">
            <span>
              <span className="block text-base font-semibold text-fg">Team</span>
              <span className="mt-0.5 block text-xs text-muted">
                {team.memberships.length} members
                {team.invitations.length ? ` · ${team.invitations.length} pending` : ""}
              </span>
            </span>
            <span aria-hidden="true" className="text-xl text-muted transition-transform group-open:rotate-45 motion-reduce:transition-none">
              +
            </span>
          </summary>
          <div className="space-y-7 border-t border-border/60 p-5 sm:p-6">
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
              <button type="submit" className="mb-btn mb-btn-primary min-h-11 self-end px-5">
                Invite
              </button>
            </form>

            <div className="divide-y divide-border/55 border-y border-border/60">
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
                          <select
                            name="role"
                            defaultValue={role}
                            aria-label={`Role for ${user.email}`}
                            className="mb-field h-10 w-28 text-xs"
                          >
                            <option value="MEMBER">Member</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                          <button type="submit" className="min-h-10 px-2 text-xs text-muted hover:text-fg">
                            Update
                          </button>
                        </form>
                        <form action={removeAction}>
                          <input type="hidden" name="email" value={user.email} />
                          <button type="submit" className="min-h-10 px-2 text-xs text-muted hover:text-danger">
                            Remove
                          </button>
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
                      <select
                        name="role"
                        defaultValue={invitation.role}
                        aria-label={`Role for ${invitation.email}`}
                        className="mb-field h-10 w-28 text-xs"
                      >
                        <option value="MEMBER">Member</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                      <button type="submit" className="min-h-10 px-2 text-xs text-muted hover:text-fg">
                        Update
                      </button>
                    </form>
                    <form action={removeAction}>
                      <input type="hidden" name="email" value={invitation.email} />
                      <button type="submit" className="min-h-10 px-2 text-xs text-muted hover:text-danger">
                        Revoke
                      </button>
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
