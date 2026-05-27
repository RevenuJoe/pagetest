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

  const out: TechnicalImprovement[] = [];
  for (const ref of refs) {
    if (!ref.id) continue;
    if (ref.group !== "load-opportunities" && ref.group !== "diagnostics") {
      continue;
    }
    const audit = audits[ref.id];
    if (!audit) continue;
    // Skip audits that don't represent a meaningful problem.
    const score = audit.score ?? null;
    if (score === null) {
      // Diagnostics often have null score; keep them only when they have a
      // displayValue (i.e. something noteworthy to report).
      if (!audit.displayValue) continue;
    } else if (score >= 1) {
      continue; // Passing audit — no improvement needed.
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
    });
  }
  return out;
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
  const params = new URLSearchParams({
    url,
    strategy,
    category: "performance",
  });
  const key = process.env.PAGESPEED_API_KEY;
  if (key) params.set("key", key);

  const res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, {
    // PSI runs Lighthouse on Google's infrastructure, can take 20-40s.
    signal: AbortSignal.timeout(60_000),
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
  const performanceScore = Math.round(
    ((lh.categories?.performance?.score ?? 0) as number) * 100,
  );

  const finalScreenshot = audits["final-screenshot"]?.details?.data ?? null;
  const fullPageScreenshot =
    audits["full-page-screenshot"]?.details?.screenshot?.data ?? null;

  return {
    strategy,
    performanceScore,
    lcpMs: audits["largest-contentful-paint"]?.numericValue ?? null,
    fcpMs: audits["first-contentful-paint"]?.numericValue ?? null,
    speedIndexMs: audits["speed-index"]?.numericValue ?? null,
    tbtMs: audits["total-blocking-time"]?.numericValue ?? null,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
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
  return [...merged.values()]
    .sort((a, b) => {
      const aSavings = a.overallSavingsMs ?? 0;
      const bSavings = b.overallSavingsMs ?? 0;
      if (aSavings !== bSavings) return bSavings - aSavings;
      const aScore = a.score ?? 1;
      const bScore = b.score ?? 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.title.localeCompare(b.title);
    })
    .slice(0, 15);
}
