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
  /** High-resolution above-the-fold screenshot from the desktop Lighthouse run, as data URL. */
  desktopScreenshot?: string;
  /** High-resolution above-the-fold screenshot from the mobile Lighthouse run, as data URL. */
  mobileScreenshot?: string;
}

export interface AnalyzeError {
  error: string;
  details?: string;
}
