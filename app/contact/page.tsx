import type { Metadata } from "next";
import Link from "next/link";
import { ContactForm } from "@/components/contact/ContactForm";
import { breadcrumbJsonLd, DEFAULT_OG_IMAGE, SEO_KEYWORDS } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact",
  description: "Send MineBench a bug report, feature request, or feedback.",
  keywords: [...SEO_KEYWORDS, "MineBench contact", "MineBench feedback"],
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact MineBench",
    description: "Bugs, ideas, and feedback.",
    url: "/contact",
    images: [{ url: DEFAULT_OG_IMAGE, alt: "MineBench AI voxel build benchmark" }],
  },
  twitter: {
    title: "Contact MineBench",
    description: "Bugs, ideas, and feedback.",
    images: [DEFAULT_OG_IMAGE],
  },
};

const breadcrumbData = breadcrumbJsonLd([
  { name: "Arena", path: "/" },
  { name: "Contact", path: "/contact" },
]);

export default function ContactPage() {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
        type="application/ld+json"
      />

      <div className="mx-auto w-full max-w-2xl py-1 sm:py-2">
        <header className="border-b border-border/70 pb-3 sm:pb-3.5">
          <p className="mb-eyebrow">Contact</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
            Contact MineBench
          </h1>
          <p className="mt-1.5 text-xs text-muted sm:text-sm">
            Bugs, ideas, and feedback. Check the{" "}
            <Link
              href="/faq"
              className="text-fg underline decoration-border/70 underline-offset-2 transition-colors hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              FAQ
            </Link>
            {" "}or{" "}
            <a
              href="https://github.com/Ammaar-Alam/minebench/issues"
              target="_blank"
              rel="noreferrer"
              className="text-fg underline decoration-border/70 underline-offset-2 transition-colors hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              GitHub Issues
            </a>
            {" "}for common topics.
          </p>
        </header>

        <ContactForm />
      </div>
    </>
  );
}
