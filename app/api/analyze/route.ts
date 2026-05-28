/**
 * POST /api/analyze
 *
 * Body: { "url": "https://example.com" }
 * Returns: AnalyzeResponse (see /lib/types.ts)
 *
 * Orchestration:
 *   1. Validate the URL.
 *   2. In parallel:
 *      - PSI desktop run
 *      - PSI mobile run
 *      - Raw HTML fetch for structure + text
 *   3. Build the "speed" check from desktop PSI numbers (deterministic).
 *   4. Call Claude once with text + both above-the-fold screenshots,
 *      get back content / digestibility / cro / aboveTheFold / mobile.
 *   5. Return everything as a single JSON payload.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPageSpeed, mergeImprovements } from "@/lib/pagespeed";
import { fetchPage } from "@/lib/fetchPage";
import { analyzeWithClaude } from "@/lib/claude";
import type {
  AnalyzeResponse,
  CheckResult,
  PsiBreakdown,
  PsiInsightsBundle,
  TechnicalImprovement,
} from "@/lib/types";
import type { PageSpeedResult } from "@/lib/pagespeed";

// Lighthouse can take 30–60s per strategy on a clean run, longer when
// Google's PSI queue is busy or the target page is heavy. We run desktop
// + mobile + fetchPage in parallel, then six Claude calls in parallel.
// 270s gives the slowest run plenty of headroom — Vercel Pro allows up
// to 300s so this stays inside the ceiling.
export const maxDuration = 270;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const url = normalizeUrl(body.url);
  if (!url) {
    return NextResponse.json(
      { error: "Please provide a valid URL (e.g. https://example.com)" },
      { status: 400 },
    );
  }

  try {
    const [desktopRes, mobileRes, page] = await Promise.allSettled([
      runPageSpeed(url, "desktop"),
      runPageSpeed(url, "mobile"),
      fetchPage(url),
    ]);

    // PSI is allowed to fail; we degrade gracefully. Log failures to the
    // server so we can see WHY in Vercel logs (e.g. timeout, 4xx, 5xx)
    // when reports come back missing a strategy.
    const desktop =
      desktopRes.status === "fulfilled" ? desktopRes.value : null;
    const mobile =
      mobileRes.status === "fulfilled" ? mobileRes.value : null;
    if (desktopRes.status === "rejected") {
      console.error("PSI desktop failed for", url, "—", errorMessage(desktopRes.reason));
    }
    if (mobileRes.status === "rejected") {
      console.error("PSI mobile failed for", url, "—", errorMessage(mobileRes.reason));
    }

    if (page.status !== "fulfilled") {
      return NextResponse.json(
        {
          error: "Could not fetch the page",
          details: errorMessage(page.reason),
        },
        { status: 502 },
      );
    }
    if (page.value.status >= 400) {
      return NextResponse.json(
        {
          error: `The target site returned HTTP ${page.value.status}.`,
        },
        { status: 502 },
      );
    }

    // Merge desktop + mobile Lighthouse opportunities + diagnostics into
    // one ranked list. We build it before the speed check so we can pull
    // image-format audits into the speed notes as priority signals.
    const technicalImprovements = mergeImprovements(
      desktop?.technicalImprovements ?? [],
      mobile?.technicalImprovements ?? [],
    );

    const speedCheck = buildSpeedCheck(desktop, mobile, technicalImprovements);

    // Pull screenshots from PSI (already base64-encoded JPEGs, prefixed).
    // Send Claude BOTH the above-the-fold viewport AND the full-page
    // screenshots so it can see content below the fold — forms at the
    // bottom, FAQ sections, social-proof logo strips, footer CTAs.
    const desktopShotData = stripDataUrlPrefix(desktop?.finalScreenshot ?? null);
    const mobileShotData = stripDataUrlPrefix(mobile?.finalScreenshot ?? null);
    const desktopFullData = stripDataUrlPrefix(desktop?.fullPageScreenshot ?? null);
    const mobileFullData = stripDataUrlPrefix(mobile?.fullPageScreenshot ?? null);

    const ai = await analyzeWithClaude({
      url,
      title: page.value.title,
      metaDescription: page.value.metaDescription,
      bodyText: page.value.bodyText,
      structure: page.value.structure,
      desktopScreenshotB64: desktopShotData,
      mobileScreenshotB64: mobileShotData,
      desktopFullPageB64: desktopFullData,
      mobileFullPageB64: mobileFullData,
    });

    const checks = {
      speed: speedCheck,
      content: ai.checks.content,
      digestibility: ai.checks.digestibility,
      cro: ai.checks.cro,
      aboveTheFold: ai.checks.aboveTheFold,
      mobile: ai.checks.mobile,
    };

    const overall = Math.round(
      (checks.speed.score +
        checks.content.score +
        checks.digestibility.score +
        checks.cro.score +
        checks.aboveTheFold.score +
        checks.mobile.score) /
        6,
    );

    // Bundle the raw per-strategy PSI breakdown so the new "PageSpeed
    // Insights" section can render it. Everything except the screenshots
    // and the technical-improvements list is dropped here — those are
    // already surfaced in their own sections.
    const psiInsights: PsiInsightsBundle = {
      desktop: desktop ? psiToBreakdown(desktop) : undefined,
      mobile: mobile ? psiToBreakdown(mobile) : undefined,
    };

    const response: AnalyzeResponse = {
      url,
      // Cleaned <title> from the scanned page (when present). The saved-reports
      // list uses this as the default report name so users see something
      // meaningful like "Odoo vs Doss — Doss" instead of just "Doss.com".
      pageTitle: page.value.title?.trim() || undefined,
      analyzedAt: new Date().toISOString(),
      overall,
      checks,
      keyTakeaways: ai.keyTakeaways,
      technicalImprovements,
      // Prefer the higher-resolution full-page screenshot when PSI gave us
      // one; otherwise fall back to the viewport-only final screenshot.
      desktopScreenshot:
        desktop?.fullPageScreenshot ?? desktop?.finalScreenshot ?? undefined,
      mobileScreenshot:
        mobile?.fullPageScreenshot ?? mobile?.finalScreenshot ?? undefined,
      pageSpeedInsights: psiInsights,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("analyze failed", err);
    return NextResponse.json(
      {
        error: "Analysis failed",
        details: errorMessage(err),
      },
      { status: 500 },
    );
  }
}

// Lighthouse audits that tell us whether the page is leaving image-format
// performance on the table. Ordered so the most directly actionable
// observation (next-gen formats) appears first.
const IMAGE_AUDIT_IDS = [
  "modern-image-formats", // "Serve images in next-gen formats" (WebP, AVIF)
  "uses-optimized-images", // "Efficiently encode images"
  "uses-responsive-images", // "Properly size images"
];

/**
 * Turn a Lighthouse image-format audit into a Speed-section note. We surface
 * the savings number Lighthouse gives us (ms or KB) so the message lands as
 * "here's how much faster the page would load if you fix this". When
 * Lighthouse rates the audit "passing" but still lists items (= the page
 * uses PNG/JPEG), we fall back to an image-count note so the user still
 * sees the finding.
 */
function buildImageNote(audit: TechnicalImprovement): string {
  // Count distinct non-modern image URLs from the items list. Lighthouse
  // returns rows like { url: "https://…/foo.png", wastedBytes: … }.
  const items = audit.items ?? [];
  const rasterCount = items.filter((row) => {
    const url = typeof row.url === "string" ? row.url.toLowerCase() : "";
    return /\.(png|jpe?g|gif|bmp|tiff?)(\?|$)/.test(url);
  }).length;

  const savings =
    audit.overallSavingsMs && audit.overallSavingsMs > 0
      ? ` (potential savings of ${(audit.overallSavingsMs / 1000).toFixed(1)}s)`
      : audit.overallSavingsBytes && audit.overallSavingsBytes > 0
      ? ` (potential savings of ${Math.round(audit.overallSavingsBytes / 1024)} KB)`
      : audit.displayValue
      ? ` (${audit.displayValue})`
      : rasterCount > 0
      ? ` (${rasterCount} image${rasterCount === 1 ? "" : "s"} on the page)`
      : "";
  // Prefix the most actionable audit ("next-gen formats") with a clear
  // recommendation so the reader knows exactly what to do.
  const prefix =
    audit.id === "modern-image-formats"
      ? "Images aren't served in next-gen formats: convert JPEG/PNG to WebP or AVIF for much smaller files"
      : audit.id === "uses-optimized-images"
      ? "Images aren't efficiently encoded: re-compress them to cut weight"
      : audit.id === "uses-responsive-images"
      ? "Images are larger than they need to be: serve correctly sized versions for the device"
      : audit.title;
  return `${prefix}${savings}.`;
}

function buildSpeedCheck(
  desktop: { performanceScore: number; lcpMs: number | null; fcpMs: number | null; speedIndexMs: number | null; tbtMs: number | null; cls: number | null } | null,
  mobile: { performanceScore: number; lcpMs: number | null; speedIndexMs?: number | null; tbtMs?: number | null; cls?: number | null } | null,
  technicalImprovements: TechnicalImprovement[] = [],
): CheckResult {
  if (!desktop && !mobile) {
    return {
      score: 0,
      headline: "PageSpeed Insights could not analyse this URL.",
      notes: [
        "The Lighthouse run failed for both desktop and mobile.",
        "If the site is private or geo-blocked, PSI can't reach it.",
      ],
    };
  }
  // Average desktop + mobile if we got both; otherwise use whichever ran.
  const score = desktop && mobile
    ? Math.round((desktop.performanceScore + mobile.performanceScore) / 2)
    : (desktop?.performanceScore ?? mobile?.performanceScore ?? 0);

  const notes: string[] = [];

  // PRIORITY 1: image-format observation. The single biggest speed lever.
  for (const id of IMAGE_AUDIT_IDS) {
    const audit = technicalImprovements.find((t) => t.id === id);
    if (!audit) continue;
    notes.push(buildImageNote(audit));
    break;
  }

  const fmt = (ms: number | null | undefined) =>
    ms == null ? null : `${(ms / 1000).toFixed(2)}s`;

  // PRIORITY 2: separate desktop and mobile speed lines so the user sees
  // both even if one strategy timed out at PSI. Includes the headline
  // performance score, LCP and Speed Index.
  if (desktop) {
    const extras = [fmt(desktop.lcpMs) && `LCP ${fmt(desktop.lcpMs)}`, fmt(desktop.speedIndexMs) && `SI ${fmt(desktop.speedIndexMs)}`]
      .filter(Boolean)
      .join(", ");
    notes.push(
      `Desktop speed: ${desktop.performanceScore}/100${extras ? ` (${extras})` : ""}.`,
    );
  }
  if (mobile) {
    const extras = [fmt(mobile.lcpMs) && `LCP ${fmt(mobile.lcpMs)}`, fmt(mobile.speedIndexMs) && `SI ${fmt(mobile.speedIndexMs)}`]
      .filter(Boolean)
      .join(", ");
    notes.push(
      `Mobile speed: ${mobile.performanceScore}/100${extras ? ` (${extras})` : ""}.`,
    );
  }

  // PRIORITY 3: individual Core Web Vital callouts when they cross
  // Google's thresholds. Each as its own bullet so the user sees exactly
  // what's failing — this restores the detail level we had originally.
  if (desktop?.tbtMs != null && desktop.tbtMs > 200) {
    notes.push(
      `Total Blocking Time is ${Math.round(desktop.tbtMs)}ms — JavaScript is delaying interactivity.`,
    );
  }
  if (desktop?.cls != null && desktop.cls > 0.1) {
    notes.push(
      `Cumulative Layout Shift is ${desktop.cls.toFixed(2)} — content is jumping during load.`,
    );
  }
  if (mobile?.lcpMs != null && mobile.lcpMs > 4000) {
    notes.push(
      `Mobile LCP is ${(mobile.lcpMs / 1000).toFixed(2)}s, well above Google's 2.5s target.`,
    );
  } else if (desktop?.lcpMs != null && desktop.lcpMs > 2500) {
    notes.push(
      `Desktop LCP is ${(desktop.lcpMs / 1000).toFixed(2)}s, slower than Google's 2.5s target.`,
    );
  }

  const headline =
    score >= 90
      ? "Page loads fast on both desktop and mobile."
      : score >= 75
      ? "Load speed is solid but has room to improve."
      : score >= 50
      ? "Load speed is mediocre, visitors will feel the lag."
      : "Page is slow enough to hurt conversions.";

  // Speed is intentionally allowed more bullets than the other cards
  // because it's deterministic + multi-strategy. Cap at 6 so it stays
  // skimmable while still surfacing the desktop + mobile detail.
  return { score, headline, notes: notes.slice(0, 6) };
}

function stripDataUrlPrefix(s: string | null): string | null {
  if (!s) return null;
  return s.startsWith("data:") ? s.replace(/^data:[^;]+;base64,/, "") : s;
}

function normalizeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function psiToBreakdown(r: PageSpeedResult): PsiBreakdown {
  return {
    performanceScore: r.performanceScore,
    accessibilityScore: r.accessibilityScore,
    bestPracticesScore: r.bestPracticesScore,
    seoScore: r.seoScore,
    lcpMs: r.lcpMs,
    fcpMs: r.fcpMs,
    speedIndexMs: r.speedIndexMs,
    tbtMs: r.tbtMs,
    cls: r.cls,
    ttiMs: r.ttiMs,
    serverResponseMs: r.serverResponseMs,
    totalByteWeight: r.totalByteWeight,
    domSize: r.domSize,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
