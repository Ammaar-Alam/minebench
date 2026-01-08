import type { Metadata } from "next";
import { IBM_Plex_Mono, Spline_Sans, Unbounded } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

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

export const metadata: Metadata = {
  title: "MineBench",
  description: "Minecraft-style voxel benchmark for comparing AI models",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`}
    >
      <body className="relative min-h-dvh bg-bg text-fg antialiased isolate">
        <Script id="mb-theme" strategy="beforeInteractive">{`
(() => {
  try {
    const key = "mb-theme";
    const saved = localStorage.getItem(key);
    const theme = saved === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {}
})();
        `}</Script>

        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
          <div className="absolute inset-0 mb-bg-mesh" />
          <div className="absolute inset-0 mb-bg-anim motion-reduce:animate-none" />
          <div className="absolute inset-0 mb-bg-grid" />
          <div className="absolute inset-0 mb-bg-noise" />
        </div>

        <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4">
          <a
            href="#main"
            className="sr-only rounded-full bg-card/80 px-4 py-2 text-sm text-fg ring-1 ring-border focus:not-sr-only focus:mt-3 focus:self-start"
          >
            Skip to content
          </a>
          <SiteHeader />
          <main id="main" className="flex-1 py-6">
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
