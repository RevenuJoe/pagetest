import type { MetadataRoute } from "next";

/**
 * /robots.txt — explicitly welcomes every major AI crawler.
 *
 * Many sites default to denying these bots. We want the Landing Page Tester
 * to be discoverable through ChatGPT, Claude, Perplexity, Google's AI
 * Overviews, Bing Chat, etc., so each one is named and allowed. The /reports
 * route is excluded because it's a per-user UI with no shareable content.
 */

const SITE_URL = "https://pages.revenuagency.io";

const AI_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "cohere-ai",
  "Bytespider",
  "Amazonbot",
  "DuckAssistBot",
  "MistralAI-User",
  "YouBot",
  "CCBot",
  "Meta-ExternalAgent",
  "FacebookBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Everyone (including standard search crawlers).
      { userAgent: "*", allow: "/", disallow: ["/reports", "/report"] },
      // Each AI crawler called out explicitly so future bot-blocking defaults
      // upstream can't silently exclude us.
      ...AI_BOTS.map((ua) => ({
        userAgent: ua,
        allow: "/",
        disallow: ["/reports", "/report"],
      })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
