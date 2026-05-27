/**
 * Score → Revenu brand colour band.
 *
 * Bands (more generous than typical Lighthouse):
 *   70+  fairly green — brand teal
 *   60-69 starting to go green — lighter teal
 *   40-59 orange — warm earth tone
 *   <40   red — coral
 */
export function scoreColor(score: number): string {
  if (score >= 70) return "#2F7D6F"; // accent — fairly green
  if (score >= 60) return "#76A09C"; // accent-lite — starting to go green
  if (score >= 40) return "#D8865A"; // warn — orangey
  return "#C44536"; // bad — red
}

export function scoreBand(score: number): "good" | "ok" | "poor" | "bad" {
  if (score >= 70) return "good";
  if (score >= 60) return "ok";
  if (score >= 40) return "poor";
  return "bad";
}
