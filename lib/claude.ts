/**
 * Claude-powered analysis of a page.
 *
 * Each Claude-scored dimension (content, digestibility, cro, aboveTheFold,
 * mobile) gets its OWN parallel Anthropic call with a focused per-dimension
 * system prompt. A 6th parallel call composes the Key Takeaways.
 *
 * Why split? A single mega-prompt covering all five dimensions tended to
 * cause attention drift — the model would gloss over rules tucked deep in
 * the system message. Per-dimension calls each see only the criteria
 * relevant to their job and stick to them much more closely. Wall-clock
 * stays similar because the six calls run in parallel.
 *
 * The "speed" score is computed deterministically from PSI on the server,
 * not by Claude.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { PageStructure } from "./fetchPage";
import type { CheckKey, CheckResult, KeyTakeaway } from "./types";
import {
  buildDimensionPrompt,
  buildTakeawaysPrompt,
  type ClaudeDimension,
} from "./scoringCriteria";

const MODEL = "claude-sonnet-4-5";

export interface ClaudeInput {
  url: string;
  title: string | null;
  metaDescription: string | null;
  bodyText: string;
  structure: PageStructure;
  /** Base64 JPEG of the desktop above-the-fold viewport. */
  desktopScreenshotB64: string | null;
  /** Base64 JPEG of the mobile above-the-fold viewport. */
  mobileScreenshotB64: string | null;
  /** Base64 JPEG of the FULL desktop page (scrolled). */
  desktopFullPageB64: string | null;
  /** Base64 JPEG of the FULL mobile page (scrolled). */
  mobileFullPageB64: string | null;
}

export type ClaudeChecks = Pick<
  Record<CheckKey, CheckResult>,
  "content" | "digestibility" | "cro" | "aboveTheFold" | "mobile"
>;

export interface ClaudeOutput {
  checks: ClaudeChecks;
  /** Top 5 categorised, page-specific takeaways. */
  keyTakeaways: KeyTakeaway[];
}

const VALID_CATEGORIES: ReadonlyArray<CheckKey> = [
  "speed",
  "content",
  "digestibility",
  "cro",
  "aboveTheFold",
  "mobile",
];

export async function analyzeWithClaude(
  input: ClaudeInput,
): Promise<ClaudeOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local or your Vercel project env.",
    );
  }
  const client = new Anthropic({ apiKey });

  // Fan out: 5 dimension calls + 1 takeaways call, ALL in parallel via
  // a single Promise.all — wall-clock stays close to one call.
  const [content, digestibility, cro, aboveTheFold, mobile, keyTakeaways] =
    await Promise.all([
      callDimension(client, input, "content"),
      callDimension(client, input, "digestibility"),
      callDimension(client, input, "cro"),
      callDimension(client, input, "aboveTheFold"),
      callDimension(client, input, "mobile"),
      callTakeaways(client, input),
    ]);

  return {
    checks: { content, digestibility, cro, aboveTheFold, mobile },
    keyTakeaways,
  };
}

/**
 * One per-dimension Claude call. Sends a focused system prompt + the
 * shared page context (structure, body text, screenshots) and asks for
 * a single { score, headline, notes } JSON object.
 */
async function callDimension(
  client: Anthropic,
  input: ClaudeInput,
  dim: ClaudeDimension,
): Promise<CheckResult> {
  const system = buildDimensionPrompt(dim);
  const userBlocks = buildUserBlocks(input, dim);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system,
    messages: [{ role: "user", content: userBlocks }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return parseDimension(text);
}

/**
 * The dedicated Key Takeaways call. Same inputs as the dimension calls
 * but its system prompt asks for 5 categorised one-liners across the
 * whole page, not a score.
 */
async function callTakeaways(
  client: Anthropic,
  input: ClaudeInput,
): Promise<KeyTakeaway[]> {
  const system = buildTakeawaysPrompt();
  const userBlocks = buildUserBlocks(input);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system,
    messages: [{ role: "user", content: userBlocks }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return parseTakeaways(text);
}

/**
 * Shared user-message builder. Includes URL + structure + body text and
 * the four screenshots, but TRIMS to what's relevant per dimension to
 * keep token usage sensible:
 *
 *   - aboveTheFold: only the above-the-fold screenshots
 *   - mobile:       only the mobile screenshots (above-the-fold + full)
 *   - others:       all four screenshots
 *   - takeaways:    all four screenshots
 */
function buildUserBlocks(
  input: ClaudeInput,
  dim?: ClaudeDimension,
): Anthropic.MessageParam["content"] {
  const blocks: Anthropic.MessageParam["content"] = [];
  blocks.push({ type: "text", text: buildPromptText(input) });

  const wantAboveFold = dim !== "mobile"; // mobile call doesn't need desktop above-the-fold
  const wantFullPage = dim !== "aboveTheFold"; // above-the-fold doesn't need full-page
  const wantDesktop = dim !== "mobile";
  const wantMobile = true;

  if (wantAboveFold && wantDesktop && input.desktopScreenshotB64) {
    blocks.push({
      type: "text",
      text: "Desktop ABOVE-THE-FOLD screenshot (what visitors see before any scroll):",
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: input.desktopScreenshotB64 },
    });
  }
  if (wantAboveFold && wantMobile && input.mobileScreenshotB64) {
    blocks.push({
      type: "text",
      text: "Mobile ABOVE-THE-FOLD screenshot (what visitors see before any scroll):",
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: input.mobileScreenshotB64 },
    });
  }
  if (wantFullPage && wantDesktop && input.desktopFullPageB64) {
    blocks.push({
      type: "text",
      text: "Desktop FULL-PAGE screenshot (entire page scrolled). Use this to see content below the fold — forms at the bottom, FAQ sections, social proof logo strips, footer CTAs all count.",
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: input.desktopFullPageB64 },
    });
  }
  if (wantFullPage && wantMobile && input.mobileFullPageB64) {
    blocks.push({
      type: "text",
      text: "Mobile FULL-PAGE screenshot (entire page scrolled):",
    });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: input.mobileFullPageB64 },
    });
  }
  return blocks;
}

function buildPromptText(input: ClaudeInput): string {
  const s = input.structure;
  // Pretty-print the parsed form field inventory. Limit to 25 lines so the
  // prompt stays compact; the count line tells the model the full total.
  const fieldLines = s.formFields.slice(0, 25).map((f) => {
    const parts: string[] = [`<${f.tag}>`];
    if (f.type) parts.push(`type="${f.type}"`);
    if (f.name) parts.push(`name="${f.name}"`);
    if (f.id) parts.push(`id="${f.id}"`);
    if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
    return `  - ${parts.join(" ")}`;
  });
  const formFieldsBlock =
    s.formFields.length === 0
      ? "  (no form fields parsed from the HTML)"
      : fieldLines.join("\n") +
        (s.formFields.length > 25
          ? `\n  ...and ${s.formFields.length - 25} more`
          : "");

  return [
    `URL: ${input.url}`,
    `Title: ${input.title ?? "(none)"}`,
    `Meta description: ${input.metaDescription ?? "(none)"}`,
    "",
    "Structural summary:",
    `- H1: ${s.h1Count}, H2: ${s.h2Count}, H3: ${s.h3Count}`,
    `- Paragraphs: ${s.paragraphCount}`,
    `- Images: ${s.imgCount} (missing alt: ${s.imgMissingAlt})`,
    `- Links: ${s.linkCount}`,
    `- Buttons: ${s.buttonCount}`,
    `- Forms: ${s.formCount}, form fields: ${s.inputCount}`,
    `- <nav>: ${s.hasNav}, <footer>: ${s.hasFooter}`,
    `- Word count: ${s.wordCount}`,
    "",
    "GROUND TRUTH — facts parsed directly from the page HTML. Treat these as authoritative. Do NOT contradict them. Do NOT claim the page has elements that aren't listed here, and do NOT recommend adding elements that ARE listed here.",
    "",
    `- Form contains a phone-number field: ${s.hasPhoneField ? "YES" : "NO"}`,
    `- Form contains an email field: ${s.hasEmailField ? "YES" : "NO"}`,
    `- Total fillable form fields on the page: ${s.formFields.length}`,
    `- Total <form> elements on the page: ${s.formCount}`,
    "- Form fields on the page (tag + attributes):",
    formFieldsBlock,
    "",
    `- Number of <nav> elements on the page: ${s.hasNav ? "1 or more" : "0"}`,
    `- Number of links inside <nav>: ${s.navLinks.length}`,
    s.navLinks.length > 0
      ? `- Nav link labels (verbatim): ${s.navLinks.map((l) => `"${l}"`).join(", ")}`
      : "- Nav link labels: (none)",
    "",
    `- Number of CTA-like buttons/links found: ${s.ctaTexts.length}`,
    s.ctaTexts.length > 0
      ? `- CTA labels (verbatim, up to 20 shown): ${s.ctaTexts.slice(0, 20).map((t) => `"${t}"`).join(", ")}`
      : "- CTA labels: (none)",
    "",
    `- Total headings (H1/H2/H3) on the page: ${s.headings.length}`,
    s.headings.length > 0
      ? `- First heading on the page: "${s.headings[0]}"`
      : "",
    s.headings.length > 1
      ? `- Last heading on the page: "${s.headings[s.headings.length - 1]}"`
      : "",
    "",
    "Body text of the FULL page (top to bottom, may be lightly truncated):",
    "---",
    input.bodyText.slice(0, 60_000),
    "---",
    "",
    "Use the body text AND the attached screenshots together to verify everything. Bottom-of-page forms, FAQ sections, social-proof logo strips, footer CTAs all count.",
  ].join("\n");
}

function parseDimension(raw: string): CheckResult {
  const parsed = parseJsonObject(raw);
  return {
    score: clampScore(parsed.score),
    headline: typeof parsed.headline === "string" ? parsed.headline : "(no summary)",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes
          .filter((x: unknown): x is string => typeof x === "string")
          .slice(0, 3)
      : [],
  };
}

function parseTakeaways(raw: string): KeyTakeaway[] {
  const parsed = parseJsonObject(raw);
  const rawTakeaways = (parsed as Record<string, unknown>).keyTakeaways;
  if (!Array.isArray(rawTakeaways)) return [];
  return rawTakeaways
    .map((it: unknown): KeyTakeaway | null => {
      if (it && typeof it === "object") {
        const obj = it as Record<string, unknown>;
        const cat = typeof obj.category === "string" ? obj.category : "";
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        if (!text) return null;
        const category = VALID_CATEGORIES.includes(cat as CheckKey)
          ? (cat as CheckKey)
          : ("content" as CheckKey);
        return { category, text };
      }
      if (typeof it === "string" && it.trim().length > 0) {
        return { category: "content" as CheckKey, text: it.trim() };
      }
      return null;
    })
    .filter((x): x is KeyTakeaway => x !== null)
    .slice(0, 5);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new Error(`Could not parse Claude response as JSON. Raw: ${raw.slice(0, 500)}`);
  }
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
