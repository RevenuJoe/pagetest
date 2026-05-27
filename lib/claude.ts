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
import type { CheckKey, CheckResult } from "./types";
import { buildSystemPrompt } from "./scoringCriteria";

const MODEL = "claude-sonnet-4-5";

export interface ClaudeInput {
  url: string;
  title: string | null;
  metaDescription: string | null;
  bodyText: string;
  structure: PageStructure;
  /** Base64-only (no data URL prefix) JPEG of the desktop final viewport. */
  desktopScreenshotB64: string | null;
  /** Base64-only (no data URL prefix) JPEG of the mobile final viewport. */
  mobileScreenshotB64: string | null;
}

export type ClaudeChecks = Pick<
  Record<CheckKey, CheckResult>,
  "content" | "digestibility" | "cro" | "aboveTheFold" | "mobile"
>;

export interface ClaudeOutput {
  checks: ClaudeChecks;
  /** 5–8 prioritized, page-specific takeaways to lift the score. */
  keyTakeaways: string[];
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

  if (input.desktopScreenshotB64) {
    userBlocks.push({
      type: "text",
      text: "Desktop above-the-fold screenshot:",
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
      text: "Mobile above-the-fold screenshot:",
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
    "Body text (may be truncated):",
    "---",
    input.bodyText.slice(0, 12_000),
    "---",
    "",
    "Score the page on content, digestibility, cro, aboveTheFold, mobile. Return JSON only.",
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
  const keyTakeaways = Array.isArray(rawTakeaways)
    ? rawTakeaways.filter((x): x is string => typeof x === "string")
    : [];

  return { checks, keyTakeaways };
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
