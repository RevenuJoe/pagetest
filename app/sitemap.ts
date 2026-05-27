import type { MetadataRoute } from "next";

const SITE_URL = "https://pages.revenuagency.io";

/**
 * /sitemap.xml — generated dynamically by Next.js. Only lists the home page;
 * /reports is per-user and excluded via robots.ts. lastModified is set at
 * build time so the sitemap auto-updates on each deploy.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
  ];
}
