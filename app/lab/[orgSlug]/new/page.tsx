import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLabOrganizationContext } from "@/lib/stealth/auth";
import { createEvaluationAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New evaluation",
  robots: { index: false, follow: false },
};

export default async function NewEvaluationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await getLabOrganizationContext(orgSlug).catch(() => null);
  if (!context) redirect("/lab/sign-in");
  const action = createEvaluationAction.bind(null, orgSlug);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 py-6 sm:py-12">
      <header className="space-y-5 border-b border-border/70 pb-6">
        <Link
          href={`/lab/${orgSlug}`}
          className="inline-flex min-h-11 items-center text-sm text-muted transition hover:text-fg"
        >
          ← {context.membership.organization.name}
        </Link>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">New evaluation</h1>
          <p className="mt-2 text-sm text-muted">Plan your checkpoint test.</p>
        </div>
      </header>

      <form action={action} className="space-y-7">
        <label className="block space-y-2 text-sm font-medium text-fg">
          <span>Name</span>
          <input name="name" required maxLength={140} autoFocus className="mb-field h-12 text-base" />
        </label>

        <fieldset className="space-y-3 border-y border-border/70 py-5">
          <legend className="text-sm font-medium text-fg">Vote goal</legend>
          <label className="block max-w-xs space-y-2 text-sm text-muted">
            <span>Decisive votes</span>
            <input
              name="targetDecisiveVotes"
              type="number"
              min={1}
              max={1_000_000}
              inputMode="numeric"
              className="mb-field h-11"
            />
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
            <input name="pauseAtGoal" type="checkbox" defaultChecked className="h-4 w-4 accent-accent" />
            Pause at goal
          </label>
          <p className="text-xs text-muted">Optional. Sampling continues without a goal.</p>
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2">
          <Link href={`/lab/${orgSlug}`} className="mb-btn mb-btn-ghost min-h-11 px-5 text-sm">
            Cancel
          </Link>
          <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
