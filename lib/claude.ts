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
import {
  type FilterContext,
  filterDimensionResult,
  filterTakeaways,
} from "./noteFilters";

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

  // Filter context — used by the deterministic note filter to cross-
  // check Claude-generated notes against parsed ground truth (nav
  // links, form fields, body text markers etc.). Built once, shared.
  const filterCtx: FilterContext = {
    structure: input.structure,
    bodyText: input.bodyText,
    url: input.url,
  };

  // Phase 1: fan out the 5 DIMENSION calls in parallel. Each call sees
  // the page evidence and returns its own { score, headline, notes }.
  const [contentRaw, digestibilityRaw, croRaw, aboveTheFoldRaw, mobileRaw] =
    await Promise.all([
      callDimension(client, input, "content"),
      callDimension(client, input, "digestibility"),
      callDimension(client, input, "cro"),
      callDimension(client, input, "aboveTheFold"),
      callDimension(client, input, "mobile"),
    ]);

  // Phase 1b: deterministic filtering. Run every dimension's notes
  // through the hallucination filter BEFORE takeaways sees them, so
  // a bad note can't propagate from a dimension to the takeaways list.
  const content = filterDimensionResult(contentRaw, "content", filterCtx);
  const digestibility = filterDimensionResult(digestibilityRaw, "digestibility", filterCtx);
  const cro = filterDimensionResult(croRaw, "cro", filterCtx);
  const aboveTheFold = filterDimensionResult(aboveTheFoldRaw, "aboveTheFold", filterCtx);
  const mobile = filterDimensionResult(mobileRaw, "mobile", filterCtx);

  // Phase 2: now that the dimensions have concluded (and been filtered),
  // run the Takeaways call with each dimension's CLEAN notes injected
  // into the prompt as the SOURCE MATERIAL. Takeaways can only
  // summarise / re-prioritise what the dimensions already concluded —
  // it can't invent new observations.
  const dimensionResults = { content, digestibility, cro, aboveTheFold, mobile };
  const rawTakeaways = await callTakeaways(client, input, dimensionResults);

  // Phase 2b: filter takeaways too, in case Claude re-introduced a
  // hallucination by rewording a dimension note.
  const keyTakeaways = filterTakeaways(rawTakeaways, filterCtx);

  return {
    checks: dimensionResults,
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
 * The dedicated Key Takeaways call. Runs AFTER the dimension calls and
 * receives each dimension's conclusion as source material — the
 * takeaways prompt asks Claude to summarise / re-prioritise what the
 * dimensions ALREADY observed, never to invent new claims. This kills
 * the "Above-the-fold says social proof is present, Takeaways
 * recommends adding social proof" contradiction.
 */
async function callTakeaways(
  client: Anthropic,
  input: ClaudeInput,
  dimensionResults: Record<ClaudeDimension, CheckResult>,
): Promise<KeyTakeaway[]> {
  const system = buildTakeawaysPrompt();
  const userBlocks = buildUserBlocks(input);
  // Append the dimension findings to the user message so Claude
  // chooses takeaways from notes the dimensions actually produced.
  const dimensionDigest = formatDimensionDigest(dimensionResults);
  userBlocks.push({ type: "text", text: dimensionDigest });
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
 * Format the five dimension results into a structured digest that the
 * Takeaways call uses as the ONLY allowed source of observations.
 * Headlines + notes are quoted verbatim so the takeaways are literally
 * a re-prioritised selection of dimension output, never new content.
 */
function formatDimensionDigest(
  results: Record<ClaudeDimension, CheckResult>,
): string {
  const labels: Record<ClaudeDimension, string> = {
    content: "Content",
    digestibility: "Digestibility",
    cro: "CRO",
    aboveTheFold: "Above the fold",
    mobile: "Mobile layout",
  };
  const order: ClaudeDimension[] = [
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  const sections = order.map((dim) => {
    const r = results[dim];
    const notes = r.notes.length === 0
      ? "  (no notes from this dimension)"
      : r.notes.map((n) => `  - ${n}`).join("\n");
    return `### ${labels[dim]} — score ${r.score}/100\nHeadline: ${r.headline}\nNotes:\n${notes}`;
  });
  return [
    "================================================================",
    "DIMENSION FINDINGS — read carefully. These are the conclusions the",
    "five dimension calls reached after analysing the page. Your Key",
    "Takeaways MUST be drawn directly from these notes and headlines.",
    "Do NOT introduce new observations or recommendations that contradict",
    "what a dimension already concluded.",
    "",
    "Example contradictions to avoid:",
    "- If Above-the-fold's headline or notes say social proof is present,",
    "  do NOT recommend adding social proof.",
    "- If a dimension's notes praise the existing form pattern, do NOT",
    "  recommend changing it.",
    "- If a dimension acknowledges a CTA exists, do NOT recommend adding",
    "  one with similar intent.",
    "",
    "Pick the 5 highest-impact recommendations from the union of these",
    "notes. Rephrase / tighten them as needed, but every takeaway must be",
    "traceable back to a note or headline below.",
    "================================================================",
    ...sections,
  ].join("\n");
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
type UserContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

function buildUserBlocks(
  input: ClaudeInput,
  dim?: ClaudeDimension,
): UserContentBlock[] {
  const blocks: UserContentBlock[] = [];
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
    "- Navigation: DO NOT comment on, count, list, praise, or recommend changes to the page's navigation. Navigation analysis is OFF-LIMITS because static HTML extraction of nav links is unreliable on modern landing pages. Skip the topic entirely in every dimension — including Above-the-fold.",
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
