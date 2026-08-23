import type { Metadata } from "next";
import Link from "next/link";
import { FaqNavigation } from "@/components/faq/FaqNavigation";
import { FaqPermalink } from "@/components/faq/FaqPermalink";
import { FAQ_ITEMS, FAQ_SECTIONS, type FaqLink } from "@/lib/faq";
import {
  breadcrumbJsonLd,
  DEFAULT_OG_IMAGE,
  faqPageJsonLd,
  SEO_KEYWORDS,
} from "@/lib/seo";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Answers about how MineBench generates, evaluates, ranks, and exports AI voxel builds.",
  keywords: [...SEO_KEYWORDS, "MineBench FAQ", "AI benchmark methodology"],
  alternates: {
    canonical: "/faq",
  },
  openGraph: {
    title: "MineBench FAQ | How the benchmark works",
    description:
      "Answers about MineBench generation, methodology, rankings, model support, and exports.",
    url: "/faq",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench AI voxel build benchmark" }],
  },
  twitter: {
    title: "MineBench FAQ | How the benchmark works",
    description:
      "Answers about MineBench generation, methodology, rankings, model support, and exports.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "FAQ", path: "/faq" },
]);

const faqData = faqPageJsonLd(
  FAQ_ITEMS.map((item) => ({
    question: item.question,
    answer: item.answer.join("\n\n"),
  })),
);

function RelatedLink({ link }: { link: FaqLink }) {
  const className =
    "inline-flex min-h-11 w-full items-center gap-1 py-2 text-sm font-medium text-fg underline decoration-border underline-offset-4 transition-colors hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none sm:w-auto";

  if (link.href.startsWith("/")) {
    return (
      <Link className={className} href={link.href}>
        {link.label}
        <span aria-hidden="true">→</span>
      </Link>
    );
  }

  return (
    <a className={className} href={link.href} rel="noreferrer" target="_blank">
      {link.label}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export default function FaqPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqData) }}
      />

      <div className="mx-auto w-full max-w-6xl">
        <header className="py-5 sm:border-b sm:border-border/70 sm:py-9">
          <h1 className="font-display text-[clamp(2.25rem,8vw,3.5rem)] font-semibold leading-none tracking-tight text-fg">
            Common Questions
          </h1>
        </header>

        <div className="grid gap-7 pb-12 sm:gap-10 sm:pb-16 sm:pt-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16 lg:pt-12">
          <FaqNavigation
            sections={FAQ_SECTIONS.map((section) => ({
              id: section.id,
              title: section.title,
              items: section.items.map((item) => ({
                id: item.id,
                question: item.question,
                navLabel: item.navLabel,
              })),
            }))}
          />

          <div className="min-w-0 space-y-12 sm:space-y-14 lg:space-y-16">
            {FAQ_SECTIONS.map((section) => (
              <section
                aria-labelledby={`${section.id}-heading`}
                className="scroll-mt-40 sm:scroll-mt-36"
                id={section.id}
                key={section.id}
              >
                <h2
                  className="font-display text-lg font-semibold tracking-tight text-fg sm:text-xl"
                  id={`${section.id}-heading`}
                >
                  {section.title}
                </h2>

                <div className="mt-4 border-t border-border">
                  {section.items.map((item) => (
                    <article
                      className="scroll-mt-40 border-b border-border/70 py-6 sm:scroll-mt-36 sm:py-8"
                      id={item.id}
                      key={item.id}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2 sm:gap-4">
                        <h3 className="min-w-0 max-w-3xl break-words text-lg font-semibold leading-7 text-fg sm:text-xl">
                          <a
                            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                            href={`#${item.id}`}
                          >
                            {item.question}
                          </a>
                        </h3>
                        <FaqPermalink id={item.id} question={item.question} />
                      </div>

                      <div className="mt-3 max-w-3xl space-y-3 break-words text-base leading-7 text-muted">
                        {item.answer.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>

                      {item.links?.length ? (
                        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                          {item.links.map((link) => (
                            <RelatedLink key={link.href} link={link} />
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
