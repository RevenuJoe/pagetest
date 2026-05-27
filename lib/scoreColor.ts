/**
 * Score → Revenu brand colour band.
 * Good scores resolve to the brand teal; bad scores to warm earth tones
 * (matching the cream-and-coral palette used across revenuagency.io).
 */
export function scoreColor(score: number): string {
  if (score >= 90) return "#2F7D6F"; // accent
  if (score >= 75) return "#76A09C"; // accent-lite
  if (score >= 60) return "#D8A14E"; // amber
  if (score >= 40) return "#D8865A"; // warn
  return "#C44536"; // bad
}

export function scoreBand(score: number): "excellent" | "good" | "ok" | "poor" | "bad" {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 60) return "ok";
  if (score >= 40) return "poor";
  return "bad";
}
