import type { Metadata } from "next";
import "./globals.css";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "MineBench",
  description: "Minecraft-style voxel benchmark for comparing AI models",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-fg">
        <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4">
          <SiteHeader />
          <main className="flex-1 py-6">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
