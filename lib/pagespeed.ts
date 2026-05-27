/**
 * Wrapper around Google PageSpeed Insights v5.
 *
 * We call it twice — once with strategy=desktop, once with strategy=mobile —
 * because the scores differ meaningfully and we want both. The two calls
 * happen in parallel from the route handler.
 */

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
}

interface PsiAudit {
  numericValue?: number;
  details?: {
    data?: string;
    screenshot?: { data?: string };
  };
}

interface PsiApiResponse {
  lighthouseResult?: {
    categories?: {
      performance?: { score?: number };
    };
    audits?: Record<string, PsiAudit>;
    /** Full HTML retrieved by Lighthouse. */
    finalDisplayedUrl?: string;
  };
  error?: { message?: string };
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
  };
}
