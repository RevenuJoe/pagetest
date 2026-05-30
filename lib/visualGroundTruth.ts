/**
 * Vision pre-pass: one Claude call that turns the Microlink screenshots
 * into deterministic ground-truth facts BEFORE the five dimension
 * calls fan out.
 *
 * The pipeline was previously: HTML scan + PSI → GROUND TRUTH block →
 * five parallel dim calls, each of which had to read the screenshots
 * AND apply criteria AND score AND write notes. That spread of work
 * meant every dim was doing some visual interpretation, and any
 * dim getting it wrong produced a hallucination the filters had to
 * mop up.
 *
 * The pre-pass moves the visual interpretation into ONE small focused
 * call whose only job is "read the pixels and fill in this JSON".
 * Its output (`VisualGroundTruth`) becomes deterministic-feeling
 * truth in the GT block, so the five dim calls never have to
 * second-guess pixel-level facts again.
 *
 * Facts produced:
 *
 *   • Nav worksheet — logo present (yes/no), button count, text-link
 *     count, the actual labels. The HTML count was unreliable (CSS-
 *     hidden items, dropdown sub-menus inflate the number), so this
 *     is the screenshot's authority over the HTML.
 *   • Hero pattern — button-only / one-field-email / dropdown-led /
 *     tickbox-led / multistep / embedded-form / unknown. Drives the
 *     AtF performance bonuses and the CRO hero-form recommendations
 *     without the model having to re-derive it inside every dim.
 *   • Strong hero visual present — single boolean.
 *   • Hero bullets present + labels.
 *   • Social proof inside the AtF viewport — boolean.
 *   • Mid-page CTAs mostly solo (vs paired) — boolean for the CRO
 *     secondary-CTA pairing rule.
 *   • Bottom form visible at the bottom of the page (above the
 *     footer) — boolean. Backs up the per-form HTML position data.
 *   • Hero headline visible text — the actual text rendered at the
 *     top of the hero. Stops the "first <h1> in source order" trap on
 *     CSS-reordered pages.
 *
 * Model: claude-sonnet-4-5 with temperature 0 and a tight JSON schema.
 * Failure is non-fatal: if the call errors or returns invalid JSON we
 * return `null` and the report falls back to the old "dim decides
 * visually" prompts (the rules for that are still in GT for safety).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VisualGroundTruth } from "./groundTruth";

const MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = `You are a precise visual fact-extractor for landing pages. You will be shown one or two screenshots of a landing page (the above-the-fold viewport and optionally the full page scrolled). Your ONLY job is to fill in a small JSON object that describes what is visible. You do NOT score, recommend, or critique. You do NOT add prose. You answer the questions with the strictest, most literal interpretation of what the pixels show. If you can't tell from the screenshots, use the literal value "unknown" where the schema allows or false / 0 where it doesn't.

WRITING STYLE: do not use em dashes (—) or en dashes (–) anywhere in any string you return. Use commas, parentheses, or two short sentences instead.`;

const USER_INSTRUCTIONS = `Look at the screenshots and return a single JSON object that conforms EXACTLY to this schema (no extra keys, no missing keys, no commentary before or after the JSON):

{
  "nav": {
    "logoPresent": boolean,          // is there a logo on the LEFT of the nav strip at the top?
    "buttonCount": number,           // count of visibly button-styled elements in the nav (coloured background, clearly clickable). Examples: "Book a Call", "Get a Demo", "Start Free Trial", "Sign Up". Do NOT count plain text links.
    "textLinkCount": number,         // count of plain text links in the nav (NOT buttons, NOT the logo). Examples: "Pricing", "Resources", "About", "Products".
    "buttonLabels": string[],        // verbatim labels of the nav buttons you counted (up to 6)
    "textLinkLabels": string[]       // verbatim labels of the nav text links you counted (up to 8)
  },
  "heroPattern": "button-only" | "one-field-email" | "dropdown-led" | "tickbox-led" | "multistep" | "embedded-form" | "unknown",
                                     // What is the primary conversion control in the hero?
                                     //   "button-only"      — only a CTA button (or two), no form fields visible
                                     //   "one-field-email"  — a single email input next to a submit button
                                     //   "dropdown-led"     — the hero leads with a <select> dropdown (e.g. "Team size", "Industry") plus a submit
                                     //   "tickbox-led"      — visible tick boxes / radio buttons / chip-style options the visitor picks from
                                     //   "multistep"        — the hero is a multi-step form / quiz with Next / Continue buttons
                                     //   "embedded-form"    — a full lead-gen form (multiple labelled inputs: name, email, company, etc.)
                                     //   "unknown"          — you can't tell from the screenshot
  "heroVisualPresent": boolean,      // is there a clear hero visual (product screenshot, illustration, photograph, looping video)? White space with one icon doesn't count.
  "heroBulletsPresent": boolean,     // are there bullet points / feature pills / checklist items in the hero copy?
  "heroBulletLabels": string[],      // verbatim text of up to 5 hero bullets if present, else []
  "socialProofAboveFold": boolean,   // do you see ANY trust markers (logos, "Trusted by N", ratings like 4.8/5, named-customer names, badges) inside the above-the-fold viewport? Logos cropped at the bottom edge of the hero still count.
  "midPageCtasMostlySolo": boolean,  // looking at the FULL-PAGE screenshot, are most mid-page CTA buttons (the ones between the hero and the footer, after content sections) standing alone, OR are most of them paired with a second CTA next to them? true = mostly solo. false = mostly paired. If you only have the AtF screenshot, return false.
  "bottomFormVisible": boolean,      // in the FULL-PAGE screenshot, is there a form (one or more input fields) visible at the bottom of the page above the footer? A one-field email input counts. If you only have the AtF screenshot, return false.
  "heroHeadlineVisible": string      // the exact text of the largest / most prominent headline at the top of the above-the-fold screenshot. Quote it verbatim. If you can't read it clearly, return "".
}

Return ONLY the JSON object. No prose, no markdown fences, no preamble.`;

/**
 * Run the vision pre-pass against the available screenshots.
 *
 * `desktopAtfB64` is the primary input. If we also have a desktop
 * full-page screenshot, we attach it as a second image so the model
 * can answer the mid-page-CTA and bottom-form questions.
 *
 * Returns `null` on any error (JSON parse failure, API error, missing
 * screenshots). The caller treats `null` as "no vision facts" and
 * the report falls back to the legacy "dim decides visually" prompts.
 */
export async function runVisualGroundTruthPass(
  client: Anthropic,
  desktopAtfB64: string | null,
  desktopFullPageB64: string | null,
  mobileAtfB64: string | null,
): Promise<VisualGroundTruth | null> {
  // Need at least one AtF screenshot or the call has nothing to read.
  const atf = desktopAtfB64 ?? mobileAtfB64;
  if (!atf) return null;

  // Anthropic SDK 0.27 uses an untyped MessageParam content array
  // here. Use the structural type ImageBlockParam | TextBlockParam
  // would also work; an inline union keeps us decoupled from SDK
  // version churn.
  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: "image/jpeg"; data: string };
      }
  > = [
    { type: "text", text: USER_INSTRUCTIONS },
    {
      type: "text",
      text:
        desktopAtfB64 != null
          ? "Above-the-fold screenshot (desktop):"
          : "Above-the-fold screenshot (mobile, used because desktop AtF is unavailable):",
    },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: atf } },
  ];
  if (desktopFullPageB64) {
    blocks.push({
      type: "text",
      text: "Full-page screenshot (desktop, entire page scrolled). Use this for the mid-page CTA and bottom-form questions.",
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: desktopFullPageB64 },
    });
  }

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: blocks }],
    });
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return null;
    const parsed = extractJson(text);
    if (!parsed) {
      console.warn("[visualGroundTruth] could not parse JSON from response:", text.slice(0, 200));
      return null;
    }
    return coerceVisualGroundTruth(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[visualGroundTruth] pre-pass failed (non-fatal): ${msg}`);
    return null;
  }
}

/** Pull the first JSON object out of a string, tolerating fenced
 *  responses and stray preamble. Returns `null` if nothing parses. */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) return null;
    try {
      return JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Best-effort coercion of the raw JSON into the typed shape. Any
 *  missing field gets a safe default; any out-of-domain heroPattern
 *  string gets coerced to "unknown". */
function coerceVisualGroundTruth(raw: Record<string, unknown>): VisualGroundTruth {
  const navRaw = (raw.nav ?? {}) as Record<string, unknown>;
  const toBool = (v: unknown, fallback = false): boolean =>
    typeof v === "boolean" ? v : fallback;
  const toInt = (v: unknown, fallback = 0): number => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
    return fallback;
  };
  const toStr = (v: unknown, fallback = ""): string =>
    typeof v === "string" ? v.trim() : fallback;
  const toStrArr = (v: unknown, cap = 8): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).slice(0, cap)
      : [];
  const ALLOWED_PATTERNS: VisualGroundTruth["heroPattern"][] = [
    "button-only",
    "one-field-email",
    "dropdown-led",
    "tickbox-led",
    "multistep",
    "embedded-form",
    "unknown",
  ];
  const rawPattern = typeof raw.heroPattern === "string" ? raw.heroPattern.trim() : "unknown";
  const heroPattern: VisualGroundTruth["heroPattern"] = (
    ALLOWED_PATTERNS as string[]
  ).includes(rawPattern)
    ? (rawPattern as VisualGroundTruth["heroPattern"])
    : "unknown";
  return {
    nav: {
      logoPresent: toBool(navRaw.logoPresent),
      buttonCount: toInt(navRaw.buttonCount),
      textLinkCount: toInt(navRaw.textLinkCount),
      buttonLabels: toStrArr(navRaw.buttonLabels, 6),
      textLinkLabels: toStrArr(navRaw.textLinkLabels, 8),
    },
    heroPattern,
    heroVisualPresent: toBool(raw.heroVisualPresent),
    heroBulletsPresent: toBool(raw.heroBulletsPresent),
    heroBulletLabels: toStrArr(raw.heroBulletLabels, 5),
    socialProofAboveFold: toBool(raw.socialProofAboveFold),
    midPageCtasMostlySolo: toBool(raw.midPageCtasMostlySolo),
    bottomFormVisible: toBool(raw.bottomFormVisible),
    heroHeadlineVisible: toStr(raw.heroHeadlineVisible),
  };
}
