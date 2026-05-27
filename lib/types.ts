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
  /** Optional user-set display name for the report. Defaults to a derivation
   *  of the URL (host + path) when not set. Only the saved-reports list
   *  uses this — the main results view always shows the full URL. */
  name?: string;
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
