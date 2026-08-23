import type { MetadataRoute } from "next";
import { SITE_HOST, SITE_URL } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/leaderboard",
          "/leaderboard/",
          "/sandbox",
          "/faq",
          "/private-evaluations",
        ],
        disallow: ["/api/", "/admin/", "/local"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_HOST,
  };
}
