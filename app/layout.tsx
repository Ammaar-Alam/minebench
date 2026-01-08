import type { Metadata } from "next";
import { IBM_Plex_Mono, Spline_Sans, Unbounded } from "next/font/google";
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
    <html lang="en" className={`${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`}>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4">
          <SiteHeader />
          <main className="flex-1 py-6">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
