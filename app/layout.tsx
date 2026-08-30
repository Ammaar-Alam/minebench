import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Spline_Sans, Unbounded } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { OfflineBanner } from "@/components/OfflineBanner";
import { PublicPresence } from "@/components/PublicPresence";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteHealthBanner } from "@/components/SiteHealthBanner";
import { VoxelExplorerProvider } from "@/components/voxel/VoxelExplorerLauncher";
import {
  DEFAULT_OG_IMAGE,
  SEO_KEYWORDS,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  softwareApplicationJsonLd,
  websiteJsonLd,
} from "@/lib/seo";

const fontSans = Spline_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
});

const fontDisplay = Unbounded({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
});

const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

const googleSiteVerification = process.env.GOOGLE_SITE_VERIFICATION;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `${SITE_NAME} | %s`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [...SEO_KEYWORDS],
  alternates: {
    canonical: "/",
  },
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: "technology",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} | AI Voxel Build Benchmark`,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: DEFAULT_OG_IMAGE,
        alt: "MineBench arena comparing AI-generated voxel builds",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} | AI Voxel Build Benchmark`,
    description: SITE_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-48x48.png", type: "image/png", sizes: "48x48" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    shortcut: [{ url: "/favicon.ico" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
  ...(googleSiteVerification ? { verification: { google: googleSiteVerification } } : {}),
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fb" },
    { media: "(prefers-color-scheme: dark)", color: "#06080b" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [websiteJsonLd, softwareApplicationJsonLd],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`}
    >
      <body className="relative min-h-dvh bg-bg text-fg antialiased isolate">
        <script
          // Applies a stored theme choice before first paint. With no stored
          // choice the stylesheet's prefers-color-scheme rules already match,
          // so nothing is written and nothing flashes.
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{var t=localStorage.getItem("mb-theme");if(t==="light"||t==="dark"){var d=document.documentElement;d.dataset.theme=t;d.style.colorScheme=t}}catch(e){}})();`,
          }}
        />

        <script
          type="application/ld+json"
          // Structured data for search engines.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />

        <VoxelExplorerProvider>
          <OfflineBanner />
          <SiteHealthBanner />

          <div id="mb-shell" className="relative z-10 flex min-h-dvh flex-col">
            <SiteHeader />
            <div id="mb-container" className="mx-auto flex w-full max-w-[92rem] flex-1 flex-col px-4 sm:px-6 lg:px-8">
              <main id="main" className="flex-1 py-4 sm:py-6">
                {children}
              </main>
              <SiteFooter />
            </div>
          </div>
          <Analytics />
          <SpeedInsights />
          <PublicPresence />
        </VoxelExplorerProvider>
      </body>
    </html>
  );
}
