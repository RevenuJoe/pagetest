export type CheckKey =
  | "speed"
  | "content"
  | "digestibility"
  | "cro"
  | "aboveTheFold"
  | "mobile";

/**
 * A categorised key takeaway. The category names which scoring dimension
 * this recommendation primarily helps (speed, cro, etc.) so we can render
 * the dimension label in bold next to the suggestion.
 */
export interface KeyTakeaway {
  category: CheckKey;
  text: string;
  /** Optional label override for display purposes. When set, the UI
   *  shows this string as the prefix (e.g. "Technical:") instead of
   *  the category's normal title. Used for synthetic items appended
   *  outside the Claude-scored category set — currently only the
   *  deterministic "implement Technical Improvements" item that
   *  always closes the recommendations list. */
  displayLabel?: string;
}

export interface CheckResult {
  /** 0–100 score. */
  score: number;
  /** A one-line summary the user will read at a glance. */
  headline: string;
  /** A short list of concrete observations or recommendations. */
  notes: string[];
}

/**
 * A single audit suggestion from Google Lighthouse (PageSpeed Insights).
 * Each one represents something specific that could be improved on the
 * page — "Properly size images", "Reduce unused JavaScript", etc.
 */
export interface TechnicalImprovement {
  /** Lighthouse audit id, e.g. "uses-optimized-images". */
  id: string;
  /** Human-readable audit title, e.g. "Properly size images". */
  title: string;
  /** Lighthouse explanation. Markdown links stripped for display. */
  description?: string;
  /** "Potential savings of 1.5 s", "21 elements", etc. */
  displayValue?: string;
  /** 0-1 audit score. Lower = bigger problem. null when not applicable. */
  score: number | null;
  /** Lighthouse group, e.g. "load-opportunities" or "diagnostics". */
  group?: string;
  /** Estimated savings in ms when Lighthouse provides it. */
  overallSavingsMs?: number;
  /** Estimated savings in bytes when Lighthouse provides it. */
  overallSavingsBytes?: number;
  /** Which device this finding came from (used when merging desktop + mobile). */
  source?: "desktop" | "mobile" | "both";
  /** Raw Lighthouse `details.items`: the per-resource breakdown that powers
   *  the "click to expand" row in Google's own PSI UI. Each item is a row
   *  with arbitrary keys (url, totalBytes, wastedBytes, wastedMs, label,
   *  duration, etc.). We keep them as loose records and pick out the most
   *  useful fields when rendering. */
  items?: Array<Record<string, string | number | boolean | undefined | null>>;
  /** Heading definitions Lighthouse provides for the items table. Each one
   *  has a `key` matching a field on the items, a human label, and a value
   *  type ("bytes", "ms", "url", "text", "thumbnail", etc.). */
  headings?: Array<{ key?: string; label?: string; valueType?: string }>;
}

/**
 * Per-strategy (desktop or mobile) Lighthouse breakdown surfaced in the
 * "PageSpeed Insights" report section. Wraps the four category scores
 * (performance / accessibility / best-practices / SEO) plus the headline
 * timing metrics from PSI's audits.
 */
export interface PsiBreakdown {
  performanceScore: number;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  tbtMs: number | null;
  cls: number | null;
  ttiMs: number | null;
  serverResponseMs: number | null;
  totalByteWeight: number | null;
  domSize: number | null;
}

export interface PsiInsightsBundle {
  desktop?: PsiBreakdown;
  mobile?: PsiBreakdown;
}

export interface AnalyzeResponse {
  url: string;
  /** User-set display name for the report. Optional — when not set, the UI
   *  falls back to `pageTitle`, then to a derivation from the URL. Only the
   *  saved-reports list shows this; the main results view always shows the
   *  full URL too. */
  name?: string;
  /** The <title> the analysed page returned. Used as the default report
   *  name on the saved-reports list when the user hasn't set one. */
  pageTitle?: string;
  /** ISO timestamp when the analysis completed. */
  analyzedAt: string;
  /** Total wall-clock runtime of the analyse request in milliseconds:
   *  Phase 0 fetches (PSI, HTML, Microlink) + the Claude pipeline +
   *  any post-processing. Surfaced in the Overview as "Runtime" so the
   *  user can see how long each report actually took. Optional for
   *  backwards-compatibility with reports saved before this field was
   *  added. */
  runtimeMs?: number;
  /** Overall score = average of the six checks, rounded to int. */
  overall: number;
  checks: Record<CheckKey, CheckResult>;
  /** Top 5 prioritised recommendations from Claude. Newer reports return
   *  categorised objects (e.g. { category: "speed", text: "..." }); older
   *  reports saved in localStorage may still have plain strings, so the
   *  renderer accepts both. */
  keyTakeaways: Array<KeyTakeaway | string>;
  /** Lighthouse audit suggestions (opportunities + diagnostics) merged
   *  across desktop and mobile runs, sorted by impact. */
  technicalImprovements?: TechnicalImprovement[];
  /** Raw per-strategy PSI breakdown surfaced as its own report section so
   *  no useful data from the API run is lost. */
  pageSpeedInsights?: PsiInsightsBundle;
  /** High-resolution above-the-fold screenshot from the desktop Lighthouse run, as data URL. */
  desktopScreenshot?: string;
  /** High-resolution above-the-fold screenshot from the mobile Lighthouse run, as data URL. */
  mobileScreenshot?: string;
  /** Microlink full-page WebP capture for desktop (whole scrolled page,
   *  stitched). Used by the Full Page Screenshot section + lightbox.
   *  Optional: only present when Microlink succeeded for the desktop
   *  full-page call. */
  desktopFullPageScreenshot?: string;
  /** Microlink full-page WebP capture for mobile (whole scrolled page,
   *  stitched). Used by the Full Page Screenshot section + lightbox.
   *  Optional: only present when Microlink succeeded for the mobile
   *  full-page call. */
  mobileFullPageScreenshot?: string;
  /** Critic verdict log, populated only when /api/analyze is called with
   *  ?debug=1. Lists every candidate item the critic looked at, its
   *  decision (KEEP / REWRITE / DROP), the reason, and the before /
   *  after text. Used to inspect what Phase 5 dropped on a real page. */
  criticVerdicts?: CriticVerdictDebugEntry[];
  /** Full per-stage trace, populated only when /api/analyze is called
   *  with ?debug=1. Captures the content created at each phase AND
   *  what was taken out at each phase with reasons. Used by the report
   *  UI to render an inline "Stage trace" inspector for tuning the
   *  pipeline. Shape mirrors lib/claude.ts DebugTrace. */
  debugTrace?: unknown;
}

/** One critic verdict entry in the debug log (see ?debug=1). */
export interface CriticVerdictDebugEntry {
  scope: "dimensions" | "takeaways";
  kind: "headline" | "note" | "takeaway";
  dim: string;
  decision: "KEEP" | "REWRITE" | "DROP";
  before: string;
  after?: string;
  reason?: string;
}

export interface AnalyzeError {
  error: string;
  details?: string;
}
