import type { Metadata } from "next";
import Link from "next/link";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE, SEO_KEYWORDS } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Private Evaluations",
  description:
    "Confidential MineBench checkpoint evaluations for approved organizations.",
  keywords: [
    ...SEO_KEYWORDS,
    "private model evaluation",
    "checkpoint evaluation",
    "confidential AI benchmark",
  ],
  alternates: {
    canonical: "/private-evaluations",
  },
  openGraph: {
    title: "MineBench Private Evaluations",
    description:
      "Confidential checkpoint evaluations with blind Arena sampling and organization-scoped reporting.",
    url: "/private-evaluations",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench AI voxel build benchmark" }],
  },
  twitter: {
    title: "MineBench Private Evaluations",
    description:
      "Confidential checkpoint evaluations with blind Arena sampling and organization-scoped reporting.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Private Evaluations", path: "/private-evaluations" },
]);

const sections = [
  {
    title: "Approved organizations",
    body: "MineBench approves an organization once. Admins can then invite teammates, and Members can run evaluation work without repeated MineBench approval.",
  },
  {
    title: "Private checkpoints",
    body: "Each evaluation can contain related confidential checkpoints while it is a draft. Once activated, the checkpoint set is fixed so results stay coherent.",
  },
  {
    title: "Endpoint or upload",
    body: "Teams can generate a cohort from a supported private endpoint or provide a complete cohort for validation. Accepted builds remain immutable.",
  },
  {
    title: "Blind Arena sampling",
    body: "Private matchups place one checkpoint against one public model. Identities stay hidden before a vote, and public rankings remain unchanged.",
  },
  {
    title: "Organization reports",
    body: "Authorized members can inspect builds, generation diagnostics, aggregate results, uncertainty, prompt performance, and approved exports.",
  },
  {
    title: "Retention window",
    body: "Closed evaluations remain available for review and export during the agreed retention period, then private data is removed from active systems.",
  },
] as const;

export default function PrivateEvaluationsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />

      <div className="mx-auto w-full max-w-6xl">
        <header className="grid gap-7 py-8 sm:border-b sm:border-border/70 sm:py-12 lg:grid-cols-[minmax(0,0.78fr)_minmax(18rem,0.42fr)] lg:gap-14">
          <div className="max-w-3xl">
            <p className="mb-eyebrow">Private Evaluations</p>
            <h1 className="mt-3 font-display text-[clamp(2.3rem,7.5vw,4.35rem)] font-semibold leading-[0.95] tracking-tight text-fg">
              Confidential checkpoint testing.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
              MineBench runs blind checkpoint evaluations for approved organizations,
              using the same Arena surface while keeping private identities, builds,
              votes, and reports scoped to authorized members.
            </p>
          </div>

          <aside className="self-end rounded-2xl border border-border bg-card/55 p-5 shadow-soft">
            <dl className="grid gap-4 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-muted/75">
                  Access
                </dt>
                <dd className="mt-1 text-fg">Approved organizations</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-muted/75">
                  Matchups
                </dt>
                <dd className="mt-1 text-fg">One checkpoint, one public model</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-muted/75">
                  Contact
                </dt>
                <dd className="mt-1">
                  <a
                    className="text-fg underline decoration-border/70 underline-offset-4 hover:decoration-fg"
                    href="mailto:support@minebench.ai?subject=MineBench%20Private%20Evaluations"
                  >
                    support@minebench.ai
                  </a>
                </dd>
              </div>
            </dl>
          </aside>
        </header>

        <section className="grid gap-8 py-9 sm:py-12 lg:grid-cols-[minmax(13rem,0.35fr)_minmax(0,0.9fr)] lg:gap-14">
          <header className="max-w-xs">
            <p className="mb-eyebrow">The workspace</p>
            <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight text-fg">
              From checkpoint to evidence.
            </h2>
          </header>
          <ol className="divide-y divide-border/60 border-y border-border/70">
            {sections.map((section, index) => (
              <li
                className="grid gap-3 py-5 sm:grid-cols-[2.25rem_minmax(11rem,0.55fr)_minmax(0,1fr)] sm:gap-5"
                key={section.title}
              >
                <span className="font-mono text-xs tabular-nums text-muted/70">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="font-display text-lg font-semibold tracking-tight text-fg">
                  {section.title}
                </h3>
                <p className="text-sm leading-6 text-muted">{section.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-border/70 py-9 sm:py-12">
          <div className="max-w-3xl space-y-5 text-base leading-7 text-muted">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">
              Request access
            </h2>
            <p>
              Private evaluations are available for model providers, research labs,
              developers, and organizations with unreleased checkpoints or confidential
              model variants. Access starts with organization approval, then the
              organization operates its workspace directly.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <a
                className="mb-btn mb-btn-primary h-11 px-5 text-sm"
                href="mailto:support@minebench.ai?subject=MineBench%20Private%20Evaluations"
              >
                Request access
              </a>
              <Link className="mb-btn mb-btn-ghost h-11 px-5 text-sm" href="/faq">
                Read FAQ
              </Link>
            </div>
            <p className="text-sm leading-6 text-muted/85">
              Confidentiality, export, disclosure, and retention terms may be governed
              by a separate evaluation agreement or data processing addendum.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
