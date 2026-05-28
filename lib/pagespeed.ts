/**
 * Wrapper around Google PageSpeed Insights v5.
 *
 * We call it twice — once with strategy=desktop, once with strategy=mobile —
 * because the scores differ meaningfully and we want both. The two calls
 * happen in parallel from the route handler.
 */

import type { TechnicalImprovement } from "./types";

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export type Strategy = "desktop" | "mobile";

export interface PageSpeedResult {
  strategy: Strategy;
  /** 0–100 Lighthouse performance score. */
  performanceScore: number;
  /** 0–100 Lighthouse accessibility score. Null when PSI didn't return it. */
  accessibilityScore: number | null;
  /** 0–100 Lighthouse best-practices score. */
  bestPracticesScore: number | null;
  /** 0–100 Lighthouse SEO score. */
  seoScore: number | null;
  /** Largest Contentful Paint, in ms. */
  lcpMs: number | null;
  /** First Contentful Paint, in ms. */
  fcpMs: number | null;
  /** Speed Index, in ms. */
  speedIndexMs: number | null;
  /** Total Blocking Time, in ms. */
  tbtMs: number | null;
  /** Cumulative Layout Shift score. */
  cls: number | null;
  /** Time to Interactive, in ms. */
  ttiMs: number | null;
  /** Server response time (TTFB), in ms. */
  serverResponseMs: number | null;
  /** Total page weight in bytes. */
  totalByteWeight: number | null;
  /** Number of DOM nodes Lighthouse counted. */
  domSize: number | null;
  /** Low-res data:image/jpeg;base64,... of the final viewport. We pass this
   *  to Claude for vision analysis — keeps the API request small. */
  finalScreenshot: string | null;
  /** Higher-resolution full-page screenshot from PSI. PSI captures this at
   *  the full device-emulation width (≈1350px desktop, ≈412px mobile) which
   *  is much sharper than `finalScreenshot` when displayed at container
   *  widths. We use this for the on-page screenshot display. */
  fullPageScreenshot: string | null;
  /** Final HTML the page rendered to (useful for content/CRO analysis). */
  renderedHtml: string | null;
  /** Lighthouse audit findings (opportunities + diagnostics) for THIS
   *  strategy. Merged across desktop and mobile in the route handler. */
  technicalImprovements: TechnicalImprovement[];
}

interface PsiAudit {
  id?: string;
  title?: string;
  description?: string;
  displayValue?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  details?: {
    data?: string;
    screenshot?: { data?: string };
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    /** Lighthouse table column definitions for `items`. */
    headings?: Array<{ key?: string; label?: string; valueType?: string }>;
    /** Per-row breakdown — what Lighthouse shows when you expand an audit
     *  inside PSI. Shape varies wildly by audit, so we accept loose records. */
    items?: Array<Record<string, unknown>>;
  };
}

interface PsiAuditRef {
  id?: string;
  weight?: number;
  group?: string;
  acronym?: string;
}

interface PsiApiResponse {
  lighthouseResult?: {
    categories?: {
      performance?: { score?: number; auditRefs?: PsiAuditRef[] };
      accessibility?: { score?: number };
      "best-practices"?: { score?: number };
      seo?: { score?: number };
    };
    audits?: Record<string, PsiAudit>;
    /** Full HTML retrieved by Lighthouse. */
    finalDisplayedUrl?: string;
  };
  error?: { message?: string };
}

/**
 * Pull out the actionable Lighthouse findings from a PSI response.
 *
 * Lighthouse groups performance audits into:
 *   - "load-opportunities" — fixes that would speed up the page (image
 *     compression, render-blocking JS, etc).
 *   - "diagnostics"        — additional info (DOM size, third-party impact).
 *
 * We pull all audits in those two groups whose score is < 1 (so they
 * actually represent something to fix) and shape them into our
 * TechnicalImprovement type.
 */
function extractImprovements(
  lh: NonNullable<PsiApiResponse["lighthouseResult"]>,
  strategy: Strategy,
): TechnicalImprovement[] {
  const refs = lh.categories?.performance?.auditRefs ?? [];
  const audits = lh.audits ?? {};

  // We pull from BOTH the "score < 1" set (genuine fixes) AND the
  // "near-passing but still flagged" set (score < 1 but not 0). Anything
  // in the load-opportunities or diagnostics groups is in scope. Passing
  // audits with a displayValue are also kept as informational rows so
  // we comfortably reach 10 surfaced items on healthy pages.
  const out: TechnicalImprovement[] = [];
  for (const ref of refs) {
    if (!ref.id) continue;
    if (ref.group !== "load-opportunities" && ref.group !== "diagnostics") {
      continue;
    }
    const audit = audits[ref.id];
    if (!audit) continue;
    const score = audit.score ?? null;
    // Skip only if score is 1 AND there's nothing informational to show.
    if (score !== null && score >= 1 && !audit.displayValue && !audit.details?.overallSavingsMs && !audit.details?.overallSavingsBytes) {
      continue;
    }
    if (score === null && !audit.displayValue && !audit.details?.overallSavingsMs && !audit.details?.overallSavingsBytes) {
      continue;
    }

    out.push({
      id: ref.id,
      title: audit.title ?? ref.id,
      description: cleanDescription(audit.description),
      displayValue: audit.displayValue,
      score,
      group: ref.group,
      overallSavingsMs: audit.details?.overallSavingsMs,
      overallSavingsBytes: audit.details?.overallSavingsBytes,
      source: strategy,
      items: shapeItems(audit.details?.items),
      headings: audit.details?.headings,
    });
  }
  return out;
}

/**
 * Pull the parts of Lighthouse `details.items` we actually want to render in
 * the expanded view, and drop the noise. Items are unioned record types; we
 * keep the primitive fields and discard nested objects (like SubItems trees
 * Lighthouse occasionally returns for tree-shaking audits). Cap at 20 rows
 * so the UI stays reasonable.
 */
function shapeItems(
  raw: Array<Record<string, unknown>> | undefined,
):
  | Array<Record<string, string | number | boolean | undefined | null>>
  | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: Array<Record<string, string | number | boolean | undefined | null>> = [];
  for (const row of raw.slice(0, 20)) {
    const shaped: Record<string, string | number | boolean | undefined | null> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v == null) continue;
      // Lighthouse sometimes nests a "url" inside `{ url: { value: "..." } }`
      // when the cell renders as a link. Unwrap when we can.
      if (typeof v === "object") {
        if ("url" in (v as Record<string, unknown>) && typeof (v as { url: unknown }).url === "string") {
          shaped[k] = (v as { url: string }).url;
        } else if ("text" in (v as Record<string, unknown>) && typeof (v as { text: unknown }).text === "string") {
          shaped[k] = (v as { text: string }).text;
        }
        // Otherwise skip — we only render primitives.
        continue;
      }
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        shaped[k] = v;
      }
    }
    if (Object.keys(shaped).length > 0) out.push(shaped);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Lighthouse descriptions are markdown with inline links of the form
 * `[label](url)`. Strip the link syntax so the UI shows plain text. Also
 * collapse stray whitespace and drop the trailing "[Learn more]" wedge
 * Lighthouse appends to most descriptions.
 */
function cleanDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw;
  // Drop trailing "[Learn more](…)" and any variations.
  s = s.replace(/\s*\[Learn more[^\]]*\]\([^)]*\)\s*\.?\s*$/i, "");
  // Convert remaining [text](url) to just text.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length === 0) return undefined;
  return s;
}

export async function runPageSpeed(
  url: string,
  strategy: Strategy,
): Promise<PageSpeedResult> {
  // Ask PSI for all four Lighthouse categories so we can surface
  // accessibility / best-practices / SEO scores alongside performance.
  const params = new URLSearchParams({ url, strategy });
  params.append("category", "performance");
  params.append("category", "accessibility");
  params.append("category", "best-practices");
  params.append("category", "seo");
  const key = process.env.PAGESPEED_API_KEY;
  if (key) params.set("key", key);

  const res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, {
    // PSI runs Lighthouse on Google's infrastructure. The desktop strategy
    // is consistently slower than mobile because Lighthouse renders the
    // full page-emulation viewport (~1350px wide) and waits for all
    // network activity to settle. 60s sometimes truncated the desktop
    // run and we'd lose it from the report; 78s gives it enough headroom
    // while still leaving budget under Vercel's 90s maxDuration.
    signal: AbortSignal.timeout(78_000),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as PsiApiResponse;
      detail = body?.error?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(
      `PageSpeed Insights returned ${res.status}: ${detail || res.statusText}`,
    );
  }

  const body = (await res.json()) as PsiApiResponse;
  const lh = body.lighthouseResult;
  if (!lh) {
    throw new Error("PageSpeed Insights returned no lighthouseResult");
  }

  const audits = lh.audits ?? {};
  const categoryScore = (raw: number | undefined | null): number | null =>
    typeof raw === "number" ? Math.round(raw * 100) : null;
  const performanceScore = categoryScore(lh.categories?.performance?.score) ?? 0;
  const accessibilityScore = categoryScore(lh.categories?.accessibility?.score);
  const bestPracticesScore = categoryScore(
    lh.categories?.["best-practices"]?.score,
  );
  const seoScore = categoryScore(lh.categories?.seo?.score);

  const finalScreenshot = audits["final-screenshot"]?.details?.data ?? null;
  const fullPageScreenshot =
    audits["full-page-screenshot"]?.details?.screenshot?.data ?? null;

  return {
    strategy,
    performanceScore,
    accessibilityScore,
    bestPracticesScore,
    seoScore,
    lcpMs: audits["largest-contentful-paint"]?.numericValue ?? null,
    fcpMs: audits["first-contentful-paint"]?.numericValue ?? null,
    speedIndexMs: audits["speed-index"]?.numericValue ?? null,
    tbtMs: audits["total-blocking-time"]?.numericValue ?? null,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    ttiMs: audits["interactive"]?.numericValue ?? null,
    serverResponseMs: audits["server-response-time"]?.numericValue ?? null,
    totalByteWeight: audits["total-byte-weight"]?.numericValue ?? null,
    domSize: audits["dom-size"]?.numericValue ?? null,
    finalScreenshot,
    fullPageScreenshot,
    renderedHtml: null,
    technicalImprovements: extractImprovements(lh, strategy),
  };
}

/**
 * Merge desktop + mobile improvements into one ranked list.
 *
 * - Dedupe by audit id; keep the entry with the LOWER score (the worse
 *   reading, so we don't soften the message).
 * - Mark `source: "both"` when the issue appears on both devices.
 * - Sort by overallSavingsMs desc, then score asc, then alphabetical.
 * - Cap at 15 items so the UI stays scannable.
 */
export function mergeImprovements(
  desktop: TechnicalImprovement[],
  mobile: TechnicalImprovement[],
): TechnicalImprovement[] {
  const merged = new Map<string, TechnicalImprovement>();
  for (const imp of [...mobile, ...desktop]) {
    const existing = merged.get(imp.id);
    if (!existing) {
      merged.set(imp.id, { ...imp });
      continue;
    }
    // Keep the worse score for honesty; flag as "both".
    const better =
      (imp.score ?? 1) < (existing.score ?? 1) ? imp : existing;
    merged.set(imp.id, { ...better, source: "both" });
  }
  // Image-format audits are ALWAYS pinned to position 1 when Lighthouse
  // flags them. Joe's rule: WebP / AVIF / efficient encoding is the single
  // most actionable speed lever, so it leads the technical improvements.
  const IMAGE_PRIORITY = new Set([
    "modern-image-formats",
    "uses-optimized-images",
    "uses-responsive-images",
  ]);
  const all = [...merged.values()];
  const imageAudits = all
    .filter((a) => IMAGE_PRIORITY.has(a.id))
    .sort((a, b) => {
      // Order within image audits: next-gen formats first, then efficient
      // encoding, then responsive images.
      const order = [
        "modern-image-formats",
        "uses-optimized-images",
        "uses-responsive-images",
      ];
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
  const others = all
    .filter((a) => !IMAGE_PRIORITY.has(a.id))
    .sort((a, b) => {
      const aSavings = a.overallSavingsMs ?? 0;
      const bSavings = b.overallSavingsMs ?? 0;
      if (aSavings !== bSavings) return bSavings - aSavings;
      const aScore = a.score ?? 1;
      const bScore = b.score ?? 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.title.localeCompare(b.title);
    });
  // Cap at 10 — the section reads as a focused punch list, not an
  // exhaustive Lighthouse dump.
  return [...imageAudits, ...others].slice(0, 10);
}
