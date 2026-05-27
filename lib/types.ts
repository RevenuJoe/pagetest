export type CheckKey =
  | "speed"
  | "content"
  | "digestibility"
  | "cro"
  | "aboveTheFold"
  | "mobile";

export interface CheckResult {
  /** 0–100 score. */
  score: number;
  /** A one-line summary the user will read at a glance. */
  headline: string;
  /** A short list of concrete observations or recommendations. */
  notes: string[];
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
  /** 5–8 prioritized, page-specific recommendations from Claude. */
  keyTakeaways: string[];
  /** High-resolution above-the-fold screenshot from the desktop Lighthouse run, as data URL. */
  desktopScreenshot?: string;
  /** High-resolution above-the-fold screenshot from the mobile Lighthouse run, as data URL. */
  mobileScreenshot?: string;
}

export interface AnalyzeError {
  error: string;
  details?: string;
}
