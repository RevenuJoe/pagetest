/**
 * POST /api/analyze
 *
 * Body: { "url": "https://example.com" }
 * Returns: AnalyzeResponse (see /lib/types.ts)
 *
 * Orchestration (see /REPORT_PROCESS_FLOW.md for the canonical breakdown):
 *   Phase 1 — In parallel: PSI desktop, PSI mobile, raw HTML fetch
 *             (fetchPage), Microlink desktop screenshot, Microlink
 *             mobile screenshot. All five run via Promise.allSettled
 *             so individual failures don't take down the route.
 *   Phase 2 — Deterministic computation: mergeImprovements, image
 *             format scan, buildSpeedCheck, psiInsights bundle.
 *   Phase 3 — Five parallel Claude dimension calls (content,
 *             digestibility, cro, aboveTheFold, mobile) — see claude.ts.
 *   Phase 3b — Deterministic note-filter sweep over each dimension.
 *   Phase 4 — Single Claude takeaways call, fed the cleaned dimension
 *             output + speed + PSI insights + tech improvements.
 *   Phase 4b — Note-filter sweep over the takeaways.
 *   Phase 5 — Critic Claude call: KEEP / REWRITE / DROP audit over
 *             every headline + note + takeaway.
 *   Phase 6 — Final deterministic contradiction sweep with ground-truth
 *             overrides.
 *   Phase 7 — Image-format takeaway prepended; response assembled.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPageSpeed, mergeImprovements } from "@/lib/pagespeed";
import { fetchPage } from "@/lib/fetchPage";
import { analyzeWithClaude } from "@/lib/claude";
import { fetchMicrolinkScreenshot } from "@/lib/screenshot";
import type {
  AnalyzeResponse,
  CheckResult,
  KeyTakeaway,
  PsiBreakdown,
  PsiInsightsBundle,
  TechnicalImprovement,
} from "@/lib/types";
import type { PageSpeedResult } from "@/lib/pagespeed";
import type { ImageFormatBreakdown } from "@/lib/fetchPage";

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
    // Kick off PSI + page fetch + high-res screenshot fetches all in
    // parallel. PSI screenshots are low-quality JPEGs at low resolution;
    // Microlink gives us crisp 2× DPR full-page captures for the displayed
    // images. Microlink can rate-limit on the free tier — in that case we
    // fall back to the PSI screenshots so the report still renders.
    const [desktopRes, mobileRes, page, microDesktopRes, microMobileRes] =
      await Promise.allSettled([
        runPageSpeed(url, "desktop"),
        runPageSpeed(url, "mobile"),
        fetchPage(url),
        fetchMicrolinkScreenshot(url, "desktop"),
        fetchMicrolinkScreenshot(url, "mobile"),
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

    // Microlink screenshot URLs (may be null if Microlink failed or
    // rate-limited). The route falls back to PSI base64 when null.
    const microDesktop =
      microDesktopRes.status === "fulfilled" ? microDesktopRes.value : null;
    const microMobile =
      microMobileRes.status === "fulfilled" ? microMobileRes.value : null;

    if (page.status !== "fulfilled") {
      return NextResponse.json(
        {
          error: "Could not fetch the page",
          details: errorMessage(page.reason),
        },
        { status: 502 },
      );
    }
    // HTTP status handling. 401 / 403 frequently appear on pages that
    // serve real, useful content behind a login wall or paywall — and
    // PSI + Microlink will often render those pages correctly even
    // though the static fetch was challenged. We log and proceed in
    // those cases. Other 4xx / 5xx codes get a specific error message
    // so the user knows what actually went wrong.
    if (page.value.status === 401 || page.value.status === 403) {
      console.warn(
        `[fetchPage] ${page.value.status} on ${url} — proceeding (login wall or paywall; PSI/Microlink may still render correctly)`,
      );
    } else if (page.value.status === 404) {
      return NextResponse.json(
        { error: "The target page returned a 404 — that URL doesn't exist." },
        { status: 502 },
      );
    } else if (page.value.status === 410) {
      return NextResponse.json(
        { error: "The target page returned a 410 — that URL has been permanently removed." },
        { status: 502 },
      );
    } else if (page.value.status === 451) {
      return NextResponse.json(
        { error: "The target page returned a 451 — content is legally unavailable." },
        { status: 502 },
      );
    } else if (page.value.status >= 500) {
      return NextResponse.json(
        { error: `The target site returned an HTTP ${page.value.status} server error. The site may be down or experiencing issues.` },
        { status: 502 },
      );
    } else if (page.value.status >= 400) {
      return NextResponse.json(
        { error: `The target site returned HTTP ${page.value.status}. Check the URL is correct.` },
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

    // Scan the raw rendered HTML for image references by format. We use
    // the per-format breakdown for the Speed section's image-format count
    // bullet and the context-aware commentary bullet. Counts are deduped
    // by URL so the same image referenced multiple times only counts once.
    const imageFormats = page.value.structure.imageFormats;

    const speedCheck = buildSpeedCheck(
      desktop,
      mobile,
      technicalImprovements,
      imageFormats,
    );

    // Pull screenshots from PSI (already base64-encoded JPEGs, prefixed).
    // Send Claude BOTH the above-the-fold viewport AND the full-page
    // screenshots so it can see content below the fold — forms at the
    // bottom, FAQ sections, social-proof logo strips, footer CTAs.
    const desktopShotData = stripDataUrlPrefix(desktop?.finalScreenshot ?? null);
    const mobileShotData = stripDataUrlPrefix(mobile?.finalScreenshot ?? null);
    const desktopFullData = stripDataUrlPrefix(desktop?.fullPageScreenshot ?? null);
    const mobileFullData = stripDataUrlPrefix(mobile?.fullPageScreenshot ?? null);

    // Build the PSI insights bundle BEFORE the Claude call so we can
    // feed it into the Takeaways context as a secondary source.
    const psiInsights: PsiInsightsBundle = {
      desktop: desktop ? psiToBreakdown(desktop) : undefined,
      mobile: mobile ? psiToBreakdown(mobile) : undefined,
    };

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
      // Feed Speed + PSI Insights + Tech Improvements into the Claude
      // pipeline so the Takeaways call sees evidence from all 6
      // sections of the report. The Takeaways prompt prioritises the 6
      // breakdowns and the PSI Insights section over Tech Improvements.
      speedCheck,
      psiInsights: {
        desktop: psiInsights.desktop
          ? {
              performanceScore: psiInsights.desktop.performanceScore,
              accessibilityScore: psiInsights.desktop.accessibilityScore,
              bestPracticesScore: psiInsights.desktop.bestPracticesScore,
              seoScore: psiInsights.desktop.seoScore,
              speedIndexMs: psiInsights.desktop.speedIndexMs,
              lcpMs: psiInsights.desktop.lcpMs,
              cls: psiInsights.desktop.cls,
              totalByteWeight: psiInsights.desktop.totalByteWeight,
            }
          : undefined,
        mobile: psiInsights.mobile
          ? {
              performanceScore: psiInsights.mobile.performanceScore,
              accessibilityScore: psiInsights.mobile.accessibilityScore,
              bestPracticesScore: psiInsights.mobile.bestPracticesScore,
              seoScore: psiInsights.mobile.seoScore,
              speedIndexMs: psiInsights.mobile.speedIndexMs,
              lcpMs: psiInsights.mobile.lcpMs,
              cls: psiInsights.mobile.cls,
              totalByteWeight: psiInsights.mobile.totalByteWeight,
            }
          : undefined,
      },
      technicalImprovements: technicalImprovements.slice(0, 10).map((t) => ({
        title: t.title,
        description: t.description,
        overallSavingsMs: t.overallSavingsMs,
        overallSavingsBytes: t.overallSavingsBytes,
      })),
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

    // Image-format takeaway. When the HTML scan found any PNG/JPEG/GIF
    // images, we prepend a deterministic "convert to WebP" takeaway as
    // priority #1 — this is the single most impactful speed win on most
    // landing pages, and we don't want to leave it to Claude to remember.
    // SVG isn't included (vector format, conversion not appropriate).
    const keyTakeaways = prependImageFormatTakeaway(
      ai.keyTakeaways,
      imageFormats,
    );

    const response: AnalyzeResponse = {
      url,
      // Cleaned <title> from the scanned page (when present). The saved-reports
      // list uses this as the default report name so users see something
      // meaningful like "Odoo vs Doss — Doss" instead of just "Doss.com".
      pageTitle: page.value.title?.trim() || undefined,
      analyzedAt: new Date().toISOString(),
      overall,
      checks,
      keyTakeaways,
      technicalImprovements,
      // For the displayed screenshots, prefer the Microlink CDN URL
      // (crisp 2× DPR above-the-fold capture) when available. Fall back
      // to PSI's viewport-only final screenshot (above-the-fold), then
      // PSI's full-page screenshot only as a last resort. The PSI
      // base64 images are still used by Claude for vision analysis;
      // only the *displayed* image changes here.
      desktopScreenshot:
        microDesktop?.url
        ?? desktop?.finalScreenshot
        ?? desktop?.fullPageScreenshot
        ?? undefined,
      mobileScreenshot:
        microMobile?.url
        ?? mobile?.finalScreenshot
        ?? mobile?.fullPageScreenshot
        ?? undefined,
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
 * Two bullets describing the page's image-format mix:
 *   1. "Image format count: 4 PNGs, 5 JPEGs, 3 WebPs..." — only formats
 *      with count > 0 are listed.
 *   2. Context-aware commentary based on the legacy/modern ratio.
 * Returns an empty array when the page has no images at all.
 */
function buildImageFormatBullets(b: ImageFormatBreakdown): string[] {
  const total = b.png + b.jpeg + b.gif + b.webp + b.avif + b.svg;
  if (total === 0) return [];

  // Bullet 1: count breakdown. Only show formats with at least one image.
  const parts: string[] = [];
  const plural = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (b.png > 0) parts.push(plural(b.png, "PNG"));
  if (b.jpeg > 0) parts.push(plural(b.jpeg, "JPEG"));
  if (b.gif > 0) parts.push(plural(b.gif, "GIF"));
  if (b.webp > 0) parts.push(plural(b.webp, "WebP"));
  if (b.avif > 0) parts.push(plural(b.avif, "AVIF"));
  if (b.svg > 0) parts.push(plural(b.svg, "SVG"));
  const countBullet = `Image format count: ${parts.join(", ")}.`;

  // Bullet 2: commentary. Only react to raster images (SVG is vector and
  // doesn't need converting). Four cases by mix of legacy/modern raster.
  let commentary: string;
  if (b.legacyRaster === 0 && b.modernRaster === 0) {
    // Page is SVG-only — nothing to convert.
    commentary =
      "All raster images on the page are vector (SVG), so format conversion isn't relevant here.";
  } else if (b.legacyRaster === 0 && b.modernRaster > 0) {
    commentary = `All raster images use modern formats (WebP/AVIF). Good work, nothing to convert here.`;
  } else if (b.modernRaster === 0 && b.legacyRaster > 0) {
    commentary = `No modern image formats in use. Convert the ${b.legacyRaster} PNG/JPEG/GIF image${b.legacyRaster === 1 ? "" : "s"} to WebP or AVIF for major file-size savings.`;
  } else if (b.modernRaster >= b.legacyRaster) {
    commentary = `Good use of WebP/AVIF, but ${b.legacyRaster} PNG/JPEG/GIF image${b.legacyRaster === 1 ? "" : "s"} remain. Migrate those too for further savings.`;
  } else {
    commentary = `Mostly PNG/JPEG with some WebP/AVIF in the mix. Convert the remaining ${b.legacyRaster} legacy raster image${b.legacyRaster === 1 ? "" : "s"} to WebP or AVIF.`;
  }

  return [countBullet, commentary];
}

/**
 * Prepend a deterministic image-format takeaway as priority #1 in the
 * Key Takeaways list. Slot #1 always carries the image-format read,
 * either as a fix or as a win:
 *
 *   - Legacy raster images present (PNG / JPEG / GIF) → "Convert N
 *     PNGs, M JPEGs to WebP for major speed gain." The single most
 *     impactful speed win on most landing pages, so we don't leave it
 *     to Claude to remember.
 *   - All raster images already use modern formats (WebP / AVIF) →
 *     "Good work: all raster images already use WebP or AVIF." A
 *     positive read so the user gets credit for already having done
 *     the optimisation.
 *   - No raster images at all (SVG-only page, or no images) → return
 *     the takeaways unchanged. Nothing useful to say about format
 *     conversion when there's nothing to convert.
 *
 * If Claude already wrote a takeaway about image formats, we strip it
 * to avoid duplication. The final list is capped at 5 takeaways.
 */
function prependImageFormatTakeaway(
  takeaways: Array<KeyTakeaway | string>,
  imageFormats: ImageFormatBreakdown,
): Array<KeyTakeaway | string> {
  // No raster images at all (e.g. SVG-only page, or no images on the
  // page). Nothing useful to say about format conversion either way.
  if (imageFormats.legacyRaster === 0 && imageFormats.modernRaster === 0) {
    return takeaways;
  }

  let text: string;
  if (imageFormats.legacyRaster === 0) {
    // All raster images already use modern formats — celebrate the win.
    text = "Good work: all raster images already use WebP or AVIF.";
  } else {
    // Build the parts list — only formats actually present in the page.
    const parts: string[] = [];
    if (imageFormats.png > 0) parts.push(`${imageFormats.png} PNG${imageFormats.png === 1 ? "" : "s"}`);
    if (imageFormats.jpeg > 0) parts.push(`${imageFormats.jpeg} JPEG${imageFormats.jpeg === 1 ? "" : "s"}`);
    if (imageFormats.gif > 0) parts.push(`${imageFormats.gif} GIF${imageFormats.gif === 1 ? "" : "s"}`);

    // Keep it tight — the takeaway text rule is max 18 words.
    text = `Convert ${parts.join(", ")} to WebP for major speed gain.`;
  }

  const synthetic: KeyTakeaway = { category: "speed", text };

  // Drop any Claude-written takeaway that touches the same topic so we
  // don't end up with two image-format items in the list.
  const filtered = takeaways.filter((t) => {
    const body = typeof t === "string" ? t : t.text;
    return !/\b(webp|avif|png|jpe?g|gif)\b/i.test(body);
  });

  // Cap at 5 total. Synthetic at #1, then up to 4 from Claude.
  return [synthetic, ...filtered].slice(0, 5);
}

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
  imageFormats: ImageFormatBreakdown = {
    png: 0,
    jpeg: 0,
    gif: 0,
    webp: 0,
    avif: 0,
    svg: 0,
    legacyRaster: 0,
    modernRaster: 0,
  },
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

  const secs = (ms: number | null | undefined) =>
    ms == null ? null : `${(ms / 1000).toFixed(2)} secs`;

  // Bullets 1–2: raw performance scores. Always show both lines when we
  // have both strategies. If one PSI run failed we just skip that bullet.
  if (desktop) {
    notes.push(`Desktop score: ${desktop.performanceScore}/100.`);
  }
  if (mobile) {
    notes.push(`Mobile score: ${mobile.performanceScore}/100.`);
  }

  // Bullets 3–4: Speed Index, desktop first then mobile so the order
  // mirrors the score lines above (desktop → mobile → desktop → mobile).
  if (desktop?.speedIndexMs != null) {
    notes.push(`Desktop speed index: ${secs(desktop.speedIndexMs)}.`);
  }
  if (mobile?.speedIndexMs != null) {
    notes.push(`Mobile speed index: ${secs(mobile.speedIndexMs)}.`);
  }

  // Bullets 5 & 6: image format count + context-aware commentary based
  // on the HTML scan. Two short bullets are easier to act on than one
  // long Lighthouse-style sentence.
  notes.push(...buildImageFormatBullets(imageFormats));

  // Bullet 6: one additional speed observation. Pick from the most
  // actionable thing left, in this order:
  //   1) The next non-image technical improvement with savings.
  //   2) A failing Core Web Vital (LCP, TBT, CLS).
  //   3) Page weight observation if total bytes is heavy.
  const otherObservation = pickSpeedObservation(
    desktop,
    mobile,
    technicalImprovements,
  );
  if (otherObservation) notes.push(otherObservation);

  const headline =
    score >= 90
      ? "Page loads fast on both desktop and mobile."
      : score >= 75
      ? "Load speed is solid but has room to improve."
      : score >= 50
      ? "Load speed is mediocre, visitors will feel the lag."
      : "Page is slow enough to hurt conversions.";

  // Up to 7 bullets: 2 scores + 2 speed-index + image count + image
  // commentary + one other observation. Cap defensively.
  return { score, headline, notes: notes.slice(0, 7) };
}

/**
 * Pick a single extra observation for the Speed card's last bullet. We
 * prefer concrete, actionable findings (a Lighthouse opportunity with real
 * savings) over generic CWV thresholds, and CWV misses over nothing.
 */
function pickSpeedObservation(
  desktop: { lcpMs: number | null; tbtMs: number | null; cls: number | null } | null,
  mobile: { lcpMs: number | null; tbtMs?: number | null; cls?: number | null } | null,
  technicalImprovements: TechnicalImprovement[],
): string | null {
  // 1) Next-most-impactful Lighthouse improvement that isn't an image
  //    audit (image is already on bullet 5).
  const nonImage = technicalImprovements.find(
    (t) =>
      !IMAGE_AUDIT_IDS.includes(t.id) &&
      ((t.overallSavingsMs ?? 0) > 0 || (t.overallSavingsBytes ?? 0) > 0),
  );
  if (nonImage) {
    const savings =
      nonImage.overallSavingsMs && nonImage.overallSavingsMs > 0
        ? ` (potential savings of ${(nonImage.overallSavingsMs / 1000).toFixed(1)}s)`
        : nonImage.overallSavingsBytes && nonImage.overallSavingsBytes > 0
        ? ` (potential savings of ${Math.round(nonImage.overallSavingsBytes / 1024)} KB)`
        : "";
    return `${nonImage.title}${savings}.`;
  }

  // 2) A Core Web Vital that's failing Google's threshold.
  if (mobile?.lcpMs != null && mobile.lcpMs > 4000) {
    return `Mobile LCP is ${(mobile.lcpMs / 1000).toFixed(2)}s, well above Google's 2.5s target.`;
  }
  if (desktop?.lcpMs != null && desktop.lcpMs > 2500) {
    return `Desktop LCP is ${(desktop.lcpMs / 1000).toFixed(2)}s, slower than Google's 2.5s target.`;
  }
  if (desktop?.tbtMs != null && desktop.tbtMs > 200) {
    return `Total Blocking Time is ${Math.round(desktop.tbtMs)}ms, JavaScript is delaying interactivity.`;
  }
  if (desktop?.cls != null && desktop.cls > 0.1) {
    return `Cumulative Layout Shift is ${desktop.cls.toFixed(2)}, content is jumping during load.`;
  }

  return null;
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
