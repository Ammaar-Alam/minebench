import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { signOutLab } from "../sign-in/actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private evaluations",
  robots: { index: false, follow: false },
};

function statusClass(status: string): string {
  if (status === "ACTIVE" || status === "STABLE") return "bg-success/10 text-success ring-success/25";
  if (status === "DEGRADED" || status === "WITHDRAWN") return "bg-warn/10 text-warn ring-warn/25";
  return "bg-bg/45 text-muted ring-border/65";
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
        },
      },
    },
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-7 py-6 sm:py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <span className="mb-eyebrow">Private evaluations</span>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            {context.membership.organization.name}
          </h1>
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
            {context.membership.role.toLowerCase()} access
          </p>
        </div>
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
        <div className="grid gap-4 md:grid-cols-2">
          {experiments.map((experiment) => {
            const decisiveVotes = experiment.variants.reduce(
              (total, variant) => total + variant.winCount + variant.lossCount,
              0,
            );
            return (
              <Link
                key={experiment.id}
                href={`/lab/${orgSlug}/experiments/${experiment.id}`}
                className="mb-panel overflow-hidden p-5 before:hidden transition hover:border-accent/35 sm:p-6"
              >
                <div className="mb-panel-inner space-y-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                      <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                        {experiment.name}
                      </h2>
                      <p className="text-sm text-muted">
                        {experiment.variants.map((variant) => variant.codename).join(" · ") || "No variants"}
                      </p>
                    </div>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ring-1 ${statusClass(experiment.status)}`}
                    >
                      {experiment.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-border/55 pt-4 text-sm">
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Variants</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums text-fg">
                        {experiment.variants.length}
                      </div>
                    </div>
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Decisive votes</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums text-fg">
                        {decisiveVotes.toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <section className="mb-panel p-5 before:hidden sm:p-7">
          <div className="mb-panel-inner space-y-3">
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">No evaluations yet</h2>
            <p className="max-w-[55ch] text-sm leading-relaxed text-muted">
              New evaluations appear here after MineBench finishes checkpoint onboarding.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
