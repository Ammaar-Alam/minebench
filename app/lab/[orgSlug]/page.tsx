import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { signOutLab } from "../sign-in/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evaluations",
  robots: { index: false, follow: false },
};

function statusClass(status: string): string {
  if (status === "ACTIVE" || status === "STABLE") return "text-success";
  if (status === "DEGRADED" || status === "WITHDRAWN") return "text-warn";
  return "text-muted";
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export default async function LabOrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) redirect("/lab/sign-in");
  const experiments = await prisma.stealthExperiment.findMany({
    where: { organizationId: context.membership.organization.id },
    orderBy: { updatedAt: "desc" },
    include: {
      variants: {
        orderBy: { codename: "asc" },
        select: {
          id: true,
          codename: true,
          status: true,
          winCount: true,
          lossCount: true,
          drawCount: true,
          bothBadCount: true,
        },
      },
    },
  });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-9 py-6 sm:py-12">
      <header className="flex flex-col gap-5 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          {context.membership.organization.name}
        </h1>
        <div className="flex items-center gap-2">
          {context.memberships.length > 1 ? (
            <Link href="/lab" className="mb-btn mb-btn-ghost h-9 px-4 text-xs">
              Organizations
            </Link>
          ) : null}
          <form action={signOutLab}>
            <button type="submit" className="mb-btn mb-btn-ghost h-9 px-4 text-xs">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {experiments.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Evaluations</h2>
          <div className="divide-y divide-border/60 border-y border-border/70">
            {experiments.map((experiment) => {
              const votes = experiment.variants.reduce(
                (total, variant) =>
                  total +
                  variant.winCount +
                  variant.lossCount +
                  variant.drawCount +
                  variant.bothBadCount,
                0,
              );
              return (
                <Link
                  key={experiment.id}
                  href={`/lab/${orgSlug}/experiments/${experiment.id}`}
                  className="group grid gap-4 py-5 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0 space-y-1.5">
                    <h3 className="text-xl font-medium tracking-tight text-fg transition-colors group-hover:text-accent">
                      {experiment.name}
                    </h3>
                    <p className="truncate text-sm text-muted">
                      {experiment.variants.map((variant) => variant.codename).join(" · ") ||
                        "No checkpoints"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm sm:justify-end">
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {votes.toLocaleString()} votes
                    </span>
                    <span
                      className={`inline-flex items-center gap-2 text-xs font-medium ${statusClass(experiment.status)}`}
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      {statusLabel(experiment.status)}
                    </span>
                    <span aria-hidden="true" className="text-muted">
                      →
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="border-y border-border/70 py-8">
          <h2 className="text-lg font-medium tracking-tight text-fg">No evaluations</h2>
        </section>
      )}
    </div>
  );
}
