/**
 * Claude-powered analysis of a page.
 *
 * One multimodal call: we hand Claude the page's structural summary, body
 * text, and two screenshots (desktop above-the-fold + mobile above-the-fold),
 * and ask for scores on the four "judgment" checks:
 *
 *   - content          — copy quality, clarity, value proposition
 *   - digestibility    — visual hierarchy, layout, scannability, navigation
 *   - cro              — CTAs, forms, friction, conversion design
 *   - aboveTheFold     — what the user sees in the first viewport
 *   - mobile           — how the layout holds up at phone width
 *
 * The "speed" score is set elsewhere from PSI's Lighthouse number.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { PageStructure } from "./fetchPage";
import type { CheckKey, CheckResult, KeyTakeaway } from "./types";
import { buildSystemPrompt } from "./scoringCriteria";

const MODEL = "claude-sonnet-4-5";

export interface ClaudeInput {
  url: string;
  title: string | null;
  metaDescription: string | null;
  bodyText: string;
  structure: PageStructure;
  /** Base64-only JPEG of the desktop above-the-fold viewport (first paint).
   *  Used specifically for the aboveTheFold dimension. */
  desktopScreenshotB64: string | null;
  /** Base64-only JPEG of the mobile above-the-fold viewport (first paint). */
  mobileScreenshotB64: string | null;
  /** Base64-only JPEG of the FULL desktop page (scrolled). Gives Claude the
   *  full picture so it can see forms, FAQs, footer CTAs, social proof
   *  logos, and anything else below the fold. */
  desktopFullPageB64: string | null;
  /** Base64-only JPEG of the FULL mobile page (scrolled). */
  mobileFullPageB64: string | null;
}

export type ClaudeChecks = Pick<
  Record<CheckKey, CheckResult>,
  "content" | "digestibility" | "cro" | "aboveTheFold" | "mobile"
>;

export interface ClaudeOutput {
  checks: ClaudeChecks;
  /** Top 5 categorised, page-specific takeaways to lift the score. */
  keyTakeaways: KeyTakeaway[];
}

// All scoring criteria live in ./scoringCriteria.ts as the single source of
// truth. Edit that file to change how Claude scores landing pages.
const SYSTEM_PROMPT = buildSystemPrompt();

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

  const userBlocks: Anthropic.MessageParam["content"] = [];

  userBlocks.push({
    type: "text",
    text: buildPromptText(input),
  });

  // Above-the-fold screenshots — used specifically for the aboveTheFold
  // dimension. Sent first so Claude evaluates them in that context.
  if (input.desktopScreenshotB64) {
    userBlocks.push({
      type: "text",
      text: "Desktop ABOVE-THE-FOLD screenshot (what visitors see before any scroll):",
    });
    userBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: input.desktopScreenshotB64,
      },
    });
  }
  if (input.mobileScreenshotB64) {
    userBlocks.push({
      type: "text",
      text: "Mobile ABOVE-THE-FOLD screenshot (what visitors see before any scroll):",
    });
    userBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: input.mobileScreenshotB64,
      },
    });
  }

  // Full-page screenshots — give Claude the WHOLE page so it can see
  // forms below the fold, FAQ sections, social-proof logos, footer CTAs.
  if (input.desktopFullPageB64) {
    userBlocks.push({
      type: "text",
      text: "Desktop FULL-PAGE screenshot (entire page scrolled). Use this to evaluate content, digestibility, CRO. The page may include forms, FAQs, social proof logos, footer CTAs that you must take into account:",
    });
    userBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: input.desktopFullPageB64,
      },
    });
  }
  if (input.mobileFullPageB64) {
    userBlocks.push({
      type: "text",
      text: "Mobile FULL-PAGE screenshot (entire page scrolled):",
    });
    userBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: input.mobileFullPageB64,
      },
    });
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlocks }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return parseOutput(text);
}

function buildPromptText(input: ClaudeInput): string {
  const s = input.structure;
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
    "Body text of the FULL page (top to bottom, may be lightly truncated):",
    "---",
    // Bumped well past the previous 12K cap so Claude sees the FAQ
    // section, the footer CTA copy, social-proof captions, etc. Claude's
    // context window easily fits this.
    input.bodyText.slice(0, 60_000),
    "---",
    "",
    "You have FOUR images attached: desktop above-the-fold, mobile above-the-fold, desktop full-page, and mobile full-page. Use the full-page screenshots to evaluate everything below the fold — forms at the bottom of the page, FAQ sections, customer-logo strips, and footer CTAs all count and must be considered. Score the page on content, digestibility, cro, aboveTheFold, mobile. Return JSON only.",
  ].join("\n");
}

function parseOutput(raw: string): ClaudeOutput {
  // Be forgiving: strip code fences if Claude returns them despite instructions.
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  // Snip down to the outermost JSON object if there's stray prose.
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `Could not parse Claude response as JSON. Raw: ${raw.slice(0, 500)}`,
    );
  }

  const requiredKeys: (keyof ClaudeChecks)[] = [
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  const checks = {} as ClaudeChecks;
  for (const k of requiredKeys) {
    const v = (parsed as Record<string, unknown>)[k];
    if (!v || typeof v !== "object") {
      throw new Error(`Claude response missing "${k}" check`);
    }
    const obj = v as Record<string, unknown>;
    checks[k] = {
      score: clampScore(obj.score),
      headline:
        typeof obj.headline === "string" ? obj.headline : "(no summary)",
      notes: Array.isArray(obj.notes)
        ? obj.notes.filter((x): x is string => typeof x === "string")
        : [],
    };
  }

  const rawTakeaways = (parsed as Record<string, unknown>).keyTakeaways;
  const validCategories: ReadonlyArray<CheckKey> = [
    "speed",
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  const keyTakeaways: KeyTakeaway[] = Array.isArray(rawTakeaways)
    ? (rawTakeaways
        .map((it) => {
          // New shape: { category, text }. Strings get bucketed under "content"
          // as a safe fallback for any model output that ignores the schema.
          if (it && typeof it === "object") {
            const obj = it as Record<string, unknown>;
            const cat = typeof obj.category === "string" ? obj.category : "";
            const text = typeof obj.text === "string" ? obj.text.trim() : "";
            if (!text) return null;
            const category = (validCategories.includes(cat as CheckKey)
              ? (cat as CheckKey)
              : "content");
            return { category, text };
          }
          if (typeof it === "string" && it.trim().length > 0) {
            return { category: "content" as CheckKey, text: it.trim() };
          }
          return null;
        })
        .filter((x): x is KeyTakeaway => x !== null)
        .slice(0, 5))
    : [];

  return { checks, keyTakeaways };
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
