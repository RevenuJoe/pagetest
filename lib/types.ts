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
  /** ISO timestamp when the analysis completed. */
  analyzedAt: string;
  /** Overall score = average of the six checks, rounded to int. */
  overall: number;
  checks: Record<CheckKey, CheckResult>;
  /** Final viewport screenshot from desktop Lighthouse run, as data URL. */
  desktopScreenshot?: string;
  /** Final viewport screenshot from mobile Lighthouse run, as data URL. */
  mobileScreenshot?: string;
}

export interface AnalyzeError {
  error: string;
  details?: string;
}
