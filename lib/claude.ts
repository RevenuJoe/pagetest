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
  runContradictionSweep,
} from "./noteFilters";

const MODEL = "claude-sonnet-4-5";

/**
 * Run an Anthropic `messages.create` call with one retry on transient
 * errors. A single 429 (rate limit), 529 (overloaded), or socket-level
 * blip currently kills the whole phase — and because dimension calls
 * run in parallel via `Promise.all`, one transient failure aborts the
 * report. One retry with a 1.5s backoff catches the overwhelming
 * majority of these without meaningfully extending wall-clock time on
 * the happy path.
 *
 * We only retry on errors that are plausibly transient: HTTP 408 / 425
 * / 429 / 500 / 502 / 503 / 504 / 529, AbortError, and "fetch failed"
 * / ECONNRESET / ETIMEDOUT-style network errors. 4xx errors that
 * indicate a real client problem (400 bad request, 401/403 auth,
 * 404, 413 payload-too-large) are NOT retried.
 */
async function createWithRetry(
  client: Anthropic,
  params: Parameters<Anthropic["messages"]["create"]>[0],
  label: string,
): Promise<Anthropic.Message> {
  const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
  try {
    return (await client.messages.create(params)) as Anthropic.Message;
  } catch (err) {
    const isTransient =
      (err instanceof Anthropic.APIError && TRANSIENT_STATUSES.has(err.status ?? 0)) ||
      (err instanceof Error &&
        /AbortError|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(
          err.message,
        ));
    if (!isTransient) throw err;
    console.warn(`[claude] ${label} transient error, retrying once:`, err instanceof Error ? err.message : err);
    await new Promise((r) => setTimeout(r, 1500));
    return (await client.messages.create(params)) as Anthropic.Message;
  }
}

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
  /** The Speed dimension result (computed deterministically server-side
   *  from PSI). Optional; included in the takeaways prompt so Takeaways
   *  can pick from all 6 sections, not just the 5 Claude-scored ones. */
  speedCheck?: CheckResult;
  /** PageSpeed Insights section data — per-strategy category scores,
   *  Speed Index, page weight, Core Web Vitals. Surfaced to Takeaways
   *  as a secondary source after the 6 dimension breakdowns. Field
   *  shape matches PsiBreakdown so route.ts can pass the existing
   *  object directly. */
  psiInsights?: {
    desktop?: {
      performanceScore: number;
      accessibilityScore: number | null;
      bestPracticesScore: number | null;
      seoScore: number | null;
      speedIndexMs: number | null;
      lcpMs: number | null;
      cls: number | null;
      totalByteWeight: number | null;
    };
    mobile?: {
      performanceScore: number;
      accessibilityScore: number | null;
      bestPracticesScore: number | null;
      seoScore: number | null;
      speedIndexMs: number | null;
      lcpMs: number | null;
      cls: number | null;
      totalByteWeight: number | null;
    };
  };
  /** Top Lighthouse technical improvements (audit titles, savings).
   *  Lowest-priority source for takeaways — only useful when a Speed
   *  takeaway needs a specific audit name. */
  technicalImprovements?: Array<{
    title: string;
    description?: string;
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
  }>;
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

/** The five Claude-scored dimensions, in canonical order. Speed is
 *  excluded because it's computed deterministically on the server. */
const CLAUDE_DIMS: ReadonlyArray<ClaudeDimension> = [
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

  // Phase 2: PARALLEL. We start two Claude calls at the same time:
  //
  //   (a) Takeaways — receives the dimensions' clean notes as source
  //       material. Takeaways can only summarise / re-prioritise what
  //       the dimensions already concluded — never invent new claims.
  //
  //   (b) Dimensions-critic — fact-checks every dimension headline and
  //       note against the same evidence the generators saw. Runs
  //       independently because takeaways only consumes the filtered
  //       (not yet critic-audited) dim notes, and we don't want to
  //       block the takeaways call waiting for the critic.
  //
  // Running these in parallel saves ~25-30s vs the old strictly-
  // sequential pipeline. Quality is preserved because every claim
  // still gets critic-audited (dim claims by the dims-critic here,
  // takeaway claims by a smaller takeaways-critic right after).
  const dimensionResultsAfterFilter = { content, digestibility, cro, aboveTheFold, mobile };
  const dimensionsCriticPromise = runCriticPass(
    client,
    input,
    dimensionResultsAfterFilter,
    [],
    "dimensions",
  );
  const takeawaysPromise = callTakeaways(client, input, dimensionResultsAfterFilter);

  // As soon as Takeaways comes back, filter it and kick off the
  // takeaways-critic. The dims-critic may still be running — both
  // critics now race to completion. The takeaways-critic has a much
  // smaller candidate list so it's typically the faster of the two.
  const rawTakeaways = await takeawaysPromise;
  const filteredTakeaways = filterTakeaways(rawTakeaways, filterCtx);
  const takeawaysCriticPromise = runCriticPass(
    client,
    input,
    dimensionResultsAfterFilter,
    filteredTakeaways,
    "takeaways",
  );

  // Wait for both critics. Each one returns the slice it audited; we
  // merge them into a single `audited` object with the same shape the
  // old all-in-one critic produced.
  const [dimensionsCriticResult, takeawaysCriticResult] = await Promise.all([
    dimensionsCriticPromise,
    takeawaysCriticPromise,
  ]);
  const audited = {
    dimensions: dimensionsCriticResult.dimensions,
    takeaways: takeawaysCriticResult.takeaways,
  };

  // Phase 4: FINAL CONTRADICTION SWEEP. Deterministic, fast. Scans the
  // whole report for "add X" recommendations where another note /
  // headline confirms X is already present. Drops the contradicting
  // item. Belt-and-braces on top of the critic pass — if anything
  // slipped through, this catches it. Always include Speed in the
  // sweep input because Tech Improvements and Speed notes are part
  // of the same report surface.
  const sweepInput: Record<string, CheckResult> = { ...audited.dimensions };
  if (input.speedCheck) sweepInput.speed = input.speedCheck;
  const swept = runContradictionSweep(
    sweepInput,
    audited.takeaways,
    input.url,
    { socialProofPresent: input.structure.socialProofPresent },
  );

  // Rebuild dimensions in the original ClaudeChecks shape (the sweep
  // returned a generic record; pull the 5 Claude dimensions back out).
  const finalDimensions = {
    content: swept.dimensions.content ?? audited.dimensions.content,
    digestibility: swept.dimensions.digestibility ?? audited.dimensions.digestibility,
    cro: swept.dimensions.cro ?? audited.dimensions.cro,
    aboveTheFold: swept.dimensions.aboveTheFold ?? audited.dimensions.aboveTheFold,
    mobile: swept.dimensions.mobile ?? audited.dimensions.mobile,
  };

  return {
    checks: finalDimensions,
    keyTakeaways: swept.takeaways,
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
  const response = await createWithRetry(
    client,
    {
      model: MODEL,
      max_tokens: 800,
      // Temperature 0 keeps output as deterministic as possible. Higher
      // temperatures invent more novel content — exactly what we don't
      // want for factual analysis of a specific page.
      temperature: 0,
      system,
      messages: [{ role: "user", content: userBlocks }],
    },
    `dim:${dim}`,
  );
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
  // Append findings from ALL SIX sections of the report (Speed + 5
  // Claude dimensions + Technical Improvements) to the user message so
  // Takeaways picks from the full evidence, not just the 5 Claude-scored
  // dimensions.
  const dimensionDigest = formatDimensionDigest(
    dimensionResults,
    input.speedCheck,
    input.psiInsights,
    input.technicalImprovements,
  );
  userBlocks.push({ type: "text", text: dimensionDigest });
  const response = await createWithRetry(
    client,
    {
      model: MODEL,
      max_tokens: 800,
      temperature: 0,
      system,
      messages: [{ role: "user", content: userBlocks }],
    },
    "takeaways",
  );
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return parseTakeaways(text);
}

// ---------------------------------------------------------------------------
// PHASE 3 — generator-then-critic fact-check
// ---------------------------------------------------------------------------

/** Where a candidate claim sits in the report so we can put verdicts back. */
type ItemKind = "headline" | "note" | "takeaway";

interface CandidateItem {
  id: number;
  kind: ItemKind;
  /** Dimension this item belongs to. For takeaways the dimension is the
   *  category Claude assigned. */
  dim: ClaudeDimension | "speed";
  /** Index within the dimension's notes (only for notes). */
  noteIndex?: number;
  /** Index within the takeaways array (only for takeaways). */
  takeawayIndex?: number;
  /** Verbatim text the model wrote. */
  text: string;
}

interface CriticVerdict {
  id: number;
  decision: "KEEP" | "REWRITE" | "DROP";
  /** New text to use when decision is REWRITE. */
  text?: string;
  reason?: string;
}

/**
 * Run a fresh Claude call that fact-checks every headline / note /
 * takeaway against the same evidence (GROUND TRUTH + body text +
 * screenshots) the generators saw. Returns the dimensions + takeaways
 * with KEEPs untouched, REWRITEs substituted, and DROPs removed.
 *
 * Rationale: the generator passes can drift from the evidence even with
 * lots of prompt rules. A second pass that ONLY judges "is this claim
 * supported?" is a much more bounded task for the model and is the
 * standard approach for factuality-critical pipelines.
 */
async function runCriticPass(
  client: Anthropic,
  input: ClaudeInput,
  dimensionResults: Record<ClaudeDimension, CheckResult>,
  takeaways: KeyTakeaway[],
  scope: "dimensions" | "takeaways" | "all" = "all",
): Promise<{
  dimensions: Record<ClaudeDimension, CheckResult>;
  takeaways: KeyTakeaway[];
}> {
  // Build the candidate list — every piece of generated text in the
  // report that the model produced (not deterministic content). The
  // `scope` parameter lets the orchestrator run the dimensions-critic
  // in parallel with Takeaways, then a smaller takeaways-critic after.
  const candidates: CandidateItem[] = [];
  let nextId = 1;
  if (scope === "dimensions" || scope === "all") {
    for (const dim of CLAUDE_DIMS) {
      const r = dimensionResults[dim];
      if (r.headline && r.headline.trim().length > 0) {
        candidates.push({ id: nextId++, kind: "headline", dim, text: r.headline });
      }
      r.notes.forEach((note, idx) => {
        candidates.push({ id: nextId++, kind: "note", dim, noteIndex: idx, text: note });
      });
    }
  }
  if (scope === "takeaways" || scope === "all") {
    takeaways.forEach((tk, idx) => {
      const text = typeof tk === "string" ? tk : tk.text;
      const dim: ClaudeDimension | "speed" =
        typeof tk === "string" ? "content" : (tk.category as ClaudeDimension | "speed");
      candidates.push({ id: nextId++, kind: "takeaway", dim, takeawayIndex: idx, text });
    });
  }

  // If nothing to audit, return inputs unchanged.
  if (candidates.length === 0) {
    return { dimensions: dimensionResults, takeaways };
  }

  // Build the critic prompt + user blocks (same evidence the generators
  // had, plus the candidate list).
  const system = buildCriticPrompt();
  const userBlocks = buildUserBlocks(input);
  userBlocks.push({ type: "text", text: formatCandidateList(candidates) });

  let verdicts: CriticVerdict[] = [];
  try {
    // max_tokens 4000 fits the full verdict JSON even when the candidate
    // list is large (5 dims × headline + ~5 notes + 5 takeaways = ~35
    // verdicts; each verdict is ~50-80 tokens with a reason). 2000 was
    // overflowing on big reports, which silently truncated the JSON and
    // tripped the parse-failure fallback (everything defaults to KEEP).
    const response = await createWithRetry(
      client,
      {
        model: MODEL,
        max_tokens: 4000,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userBlocks }],
      },
      `critic:${scope}`,
    );
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    verdicts = parseCriticVerdicts(text);
  } catch (err) {
    // If the critic call fails even after the retry, fall back to the
    // un-audited results for whichever scope was being audited. This
    // keeps the tool working when the critic API misbehaves persistently.
    console.warn(`Critic pass (scope=${scope}) failed — returning un-audited results:`, err);
    return { dimensions: dimensionResults, takeaways };
  }

  // Apply verdicts. Default for any item missing a verdict is KEEP
  // (safer than dropping everything if the critic returns a partial list).
  const verdictById = new Map<number, CriticVerdict>();
  for (const v of verdicts) verdictById.set(v.id, v);

  // Rebuild dimensions.
  const newDimensions = { ...dimensionResults };
  for (const dim of CLAUDE_DIMS) {
    const r = newDimensions[dim];
    const newNotes: string[] = [];
    let newHeadline = r.headline;
    for (const cand of candidates) {
      if (cand.dim !== dim) continue;
      const v = verdictById.get(cand.id);
      if (cand.kind === "headline") {
        if (v?.decision === "DROP") {
          newHeadline = "";
          console.warn(`[critic] DROP headline dim="${dim}" reason="${v.reason ?? ""}" text="${cand.text}"`);
        } else if (v?.decision === "REWRITE" && v.text) {
          newHeadline = v.text;
          console.warn(`[critic] REWRITE headline dim="${dim}" reason="${v.reason ?? ""}" before="${cand.text}" after="${v.text}"`);
        }
      } else if (cand.kind === "note") {
        if (v?.decision === "DROP") {
          console.warn(`[critic] DROP note dim="${dim}" reason="${v.reason ?? ""}" text="${cand.text}"`);
        } else if (v?.decision === "REWRITE" && v.text) {
          newNotes.push(v.text);
          console.warn(`[critic] REWRITE note dim="${dim}" reason="${v.reason ?? ""}" before="${cand.text}" after="${v.text}"`);
        } else {
          newNotes.push(cand.text);
        }
      }
    }
    newDimensions[dim] = { ...r, headline: newHeadline, notes: newNotes };
  }

  // Rebuild takeaways. callTakeaways always returns KeyTakeaway objects
  // (legacy string-only takeaways live in older saved reports, not in
  // newly-generated ones).
  const newTakeaways: KeyTakeaway[] = [];
  takeaways.forEach((tk, idx) => {
    const cand = candidates.find(
      (c) => c.kind === "takeaway" && c.takeawayIndex === idx,
    );
    if (!cand) {
      newTakeaways.push(tk);
      return;
    }
    const v = verdictById.get(cand.id);
    if (v?.decision === "DROP") {
      console.warn(`[critic] DROP takeaway reason="${v.reason ?? ""}" text="${cand.text}"`);
      return;
    }
    if (v?.decision === "REWRITE" && v.text) {
      newTakeaways.push({ ...tk, text: v.text });
      console.warn(`[critic] REWRITE takeaway reason="${v.reason ?? ""}" before="${cand.text}" after="${v.text}"`);
      return;
    }
    newTakeaways.push(tk);
  });

  return { dimensions: newDimensions, takeaways: newTakeaways };
}

/** System prompt for the critic. Narrow and structured — the only job
 *  is to compare each candidate claim against the page evidence. */
function buildCriticPrompt(): string {
  return [
    "You are a strict fact-checker auditing a website analysis report.",
    "",
    "You are given:",
    "  - The same page evidence the original analyser had: structural summary, GROUND TRUTH from the parsed HTML, the body text, and the above-the-fold + full-page screenshots for desktop and mobile.",
    "  - A numbered list of CANDIDATE items the original analyser produced (headlines, notes, takeaways).",
    "",
    "For each candidate, decide one of three verdicts:",
    "  - KEEP: the claim is fully supported by the evidence (a specific element in GROUND TRUTH, a quoted phrase from the body text, or a clearly visible feature in the screenshots).",
    "  - REWRITE: the claim is partly supported but contains an unsupported clause, an exaggeration, a numerical error, or a contradiction. Rewrite the claim to be conservative and supported. Keep the same intent but cut the unsupported part.",
    "  - DROP: the claim has no specific evidence in any of the three sources, or contradicts the evidence (e.g. recommends adding X when X is already present in the body text / screenshot).",
    "",
    "Hard rules:",
    "  - When in doubt, prefer REWRITE over KEEP and DROP over REWRITE. Conservative output is the goal.",
    "  - Never KEEP a claim whose evidence you cannot specifically point to.",
    "  - Never invent new content. REWRITE must be a SHORTER, more conservative version of the original — not a replacement that introduces new claims.",
    "  - Do NOT comment on navigation in any form — navigation is OFF-LIMITS as a topic. DROP any item that talks about nav links, nav bar, nav being lean/bulky/minimal, slimming the nav, adding nav links, etc.",
    "  - DROP any item that claims X is missing when X is visible in the screenshot or named in the body text.",
    "  - DROP any item that claims the page has 'two competing forms' or 'forms competing' — a multi-step form is ONE form.",
    "  - DROP any item recommending sign-in / log-in / create-account CTAs.",
    "  - DROP any item claiming 'social proof appears below the fold' or recommending 'move the trust line / logo strip / social proof into the hero / above the fold' UNLESS the above-the-fold screenshot is genuinely empty of logos, trust markers, ratings, badges, named-customer brands, and 'Trusted by N' copy. A logo strip cropped at the bottom edge of the AtF viewport STILL COUNTS as above the fold — that is not 'below the fold'. The screenshot is the only authority for fold position.",
    "",
    "Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:",
    "",
    '{ "verdicts": [ { "id": <number>, "decision": "KEEP" | "REWRITE" | "DROP", "text": "<rewritten text — only when decision is REWRITE>", "reason": "<one short clause: what evidence is missing or what was wrong>" }, ... ] }',
    "",
    "Include exactly one verdict per candidate id. If you forget an id, the system assumes KEEP — so always emit all ids.",
  ].join("\n");
}

/** Inline the candidate list at the end of the critic's user message. */
function formatCandidateList(candidates: CandidateItem[]): string {
  const lines: string[] = [];
  lines.push("================================================================");
  lines.push("CANDIDATE ITEMS TO AUDIT");
  lines.push("================================================================");
  for (const c of candidates) {
    const dimLabel = c.dim;
    lines.push(`[${c.id}] (${c.kind} • ${dimLabel}) ${c.text}`);
  }
  return lines.join("\n");
}

/** Parse the critic's JSON response into structured verdicts. Tolerant
 *  of common output mistakes — extra fields, missing reasons, etc. */
function parseCriticVerdicts(raw: string): CriticVerdict[] {
  const parsed = parseJsonObject(raw);
  const items = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const out: CriticVerdict[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const id = typeof rec.id === "number" ? rec.id : null;
    const decisionRaw = typeof rec.decision === "string" ? rec.decision.toUpperCase() : null;
    if (id == null || !decisionRaw) continue;
    if (decisionRaw !== "KEEP" && decisionRaw !== "REWRITE" && decisionRaw !== "DROP") continue;
    out.push({
      id,
      decision: decisionRaw as CriticVerdict["decision"],
      text: typeof rec.text === "string" ? rec.text : undefined,
      reason: typeof rec.reason === "string" ? rec.reason : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Format the five dimension results into a structured digest that the
 * Takeaways call uses as the ONLY allowed source of observations.
 * Headlines + notes are quoted verbatim so the takeaways are literally
 * a re-prioritised selection of dimension output, never new content.
 */
function formatDimensionDigest(
  results: Record<ClaudeDimension, CheckResult>,
  speedCheck?: CheckResult,
  psiInsights?: ClaudeInput["psiInsights"],
  technicalImprovements?: ClaudeInput["technicalImprovements"],
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

  // Speed section — populated from the server-side deterministic check
  // so Takeaways can recommend speed fixes that match what the Speed
  // breakdown actually showed.
  const speedSection = speedCheck
    ? [
        `### Speed — score ${speedCheck.score}/100`,
        `Headline: ${speedCheck.headline}`,
        `Notes:`,
        ...(speedCheck.notes.length === 0
          ? ["  (no notes from this dimension)"]
          : speedCheck.notes.map((n) => `  - ${n}`)),
      ].join("\n")
    : null;

  const claudeSections = order.map((dim) => {
    const r = results[dim];
    const notes = r.notes.length === 0
      ? "  (no notes from this dimension)"
      : r.notes.map((n) => `  - ${n}`).join("\n");
    return `### ${labels[dim]} — score ${r.score}/100\nHeadline: ${r.headline}\nNotes:\n${notes}`;
  });

  // PageSpeed Insights numerical block — per-strategy category scores
  // + Speed Index + page weight + CWV. SECONDARY source for takeaways
  // after the 6 dimension breakdowns.
  const psiSection = (() => {
    if (!psiInsights || (!psiInsights.desktop && !psiInsights.mobile)) return null;
    const lines: string[] = ["### PageSpeed Insights (secondary source)"];
    const fmtScore = (n: number | null) => (n == null ? "—" : `${n}/100`);
    const fmtSecs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)}s`);
    const fmtMb = (b: number | null) =>
      b == null ? "—" : `${(b / 1024 / 1024).toFixed(2)} MB`;
    const fmtCls = (v: number | null) => (v == null ? "—" : v.toFixed(3));
    for (const strat of ["desktop", "mobile"] as const) {
      const s = psiInsights[strat];
      if (!s) continue;
      lines.push(
        `  ${strat.toUpperCase()}: Performance ${fmtScore(s.performanceScore)} • Accessibility ${fmtScore(s.accessibilityScore)} • Best Practices ${fmtScore(s.bestPracticesScore)} • SEO ${fmtScore(s.seoScore)}`,
      );
      lines.push(
        `    Speed Index ${fmtSecs(s.speedIndexMs)} • LCP ${fmtSecs(s.lcpMs)} • CLS ${fmtCls(s.cls)} • Page weight ${fmtMb(s.totalByteWeight)}`,
      );
    }
    return lines.join("\n");
  })();

  // Technical Improvements section — Lighthouse audits with concrete
  // savings numbers. LOWEST-priority source. The 6 breakdowns + PSI
  // section are the primary source; only pull from this list when a
  // Speed takeaway specifically needs a Lighthouse audit name.
  const techSection =
    technicalImprovements && technicalImprovements.length > 0
      ? [
          "### Technical Improvements (LOWEST-priority source)",
          "These are individual Lighthouse audit findings. Use this list SPARINGLY — only when a Speed-category takeaway needs a specific Lighthouse audit name (e.g. 'Reduce unused JavaScript'). Prefer the 6 dimension breakdowns and PageSpeed Insights section above. Do NOT use this list as the basis for Content / CRO / Above-the-fold / Mobile / Digestibility takeaways.",
          ...technicalImprovements.slice(0, 10).map((t) => {
            const savings =
              t.overallSavingsMs && t.overallSavingsMs > 0
                ? ` (saves ~${(t.overallSavingsMs / 1000).toFixed(1)}s)`
                : t.overallSavingsBytes && t.overallSavingsBytes > 0
                ? ` (saves ~${Math.round(t.overallSavingsBytes / 1024)} KB)`
                : "";
            return `  - ${t.title}${savings}`;
          }),
        ].join("\n")
      : null;

  return [
    "================================================================",
    "REPORT FINDINGS — read carefully. These are the conclusions the",
    "previous analysis steps reached about the page. Your Key Takeaways",
    "MUST be drawn directly from these notes and headlines.",
    "Do NOT introduce new observations or recommendations that contradict",
    "what a section already concluded.",
    "",
    "PRIORITY ORDER for picking takeaways:",
    "  1. The SIX BREAKDOWN sections (Speed + Content + Digestibility +",
    "     CRO + Above-the-fold + Mobile). These are the primary source",
    "     because they reflect the actual scoring logic.",
    "  2. The PageSpeed Insights section. Use for Speed-related",
    "     recommendations grounded in actual PSI numbers.",
    "  3. The Technical Improvements list. Lowest priority — only for",
    "     specific Lighthouse audit references in a Speed takeaway.",
    "",
    "Example contradictions to avoid:",
    "- If Above-the-fold's headline or notes say social proof is present,",
    "  do NOT recommend adding social proof.",
    "- If a section praises the existing form pattern, do NOT",
    "  recommend changing it.",
    "- If a section acknowledges a CTA exists, do NOT recommend adding",
    "  one with similar intent.",
    "",
    "Pick the 5 highest-impact recommendations. Rephrase / tighten as",
    "needed, but every takeaway must be traceable back to a note,",
    "headline, or numerical reading from the sections below.",
    "================================================================",
    ...(speedSection ? [speedSection] : []),
    ...claudeSections,
    ...(psiSection ? [psiSection] : []),
    ...(techSection ? [techSection] : []),
  ].join("\n");
}

/**
 * Shared user-message builder. Includes URL + structure + body text and
 * the four screenshots, but TRIMS to what's relevant per dimension to
 * keep token usage sensible and Claude's focus tight:
 *
 *   - aboveTheFold: mobile above-the-fold screenshot only (same image
 *                   shown in the finished report)
 *   - mobile:       mobile full-page screenshot only (includes the top
 *                   of the page already)
 *   - content/digestibility/cro: all four screenshots
 *   - takeaways/critic:          all four screenshots
 */
type UserContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

function buildUserBlocks(
  input: ClaudeInput,
  dim?: ClaudeDimension,
): UserContentBlock[] {
  const blocks: UserContentBlock[] = [];
  // Body-text budget per dimension. Content / Digestibility / CRO need
  // the full page so they can reason about copy, structure, and
  // conversion flow end to end. AtF and Mobile are judged primarily
  // from the screenshots; the body-text excerpt only needs to cover
  // the hero region (~15,000 chars handily includes that on every
  // landing page tested). Same applies for Takeaways / Critic where
  // dim is undefined — they need the full page.
  const bodyTextCharLimit =
    dim === "aboveTheFold" || dim === "mobile" ? 15_000 : 60_000;
  blocks.push({ type: "text", text: buildPromptText(input, bodyTextCharLimit) });

  const wantAboveFold = dim !== "mobile"; // mobile call doesn't need the AtF crops — the mobile full-page already includes the top of the page
  const wantFullPage = dim !== "aboveTheFold"; // above-the-fold dim doesn't need full-page — focus stays on the hero
  // Desktop images are sent only to content/digestibility/cro. The AtF dim
  // is judged purely from the mobile AtF screenshot (same one shown in the
  // finished report) and the mobile dim is judged from the mobile full-page.
  const wantDesktop = dim !== "mobile" && dim !== "aboveTheFold";
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

function buildPromptText(input: ClaudeInput, bodyTextCharLimit = 60_000): string {
  const s = input.structure;
  // Pretty-print the parsed form field inventory. Limit to 25 lines so the
  // prompt stays compact; the count line tells the model the full total.
  const fieldLines = s.formFields.slice(0, 25).map((f) => {
    const parts: string[] = [`<${f.tag}>`];
    if (f.type) parts.push(`type="${f.type}"`);
    if (f.name) parts.push(`name="${f.name}"`);
    if (f.id) parts.push(`id="${f.id}"`);
    if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
    if (f.tag === "select" && typeof f.optionCount === "number") {
      parts.push(`options=${f.optionCount}`);
      if (f.optionLabels && f.optionLabels.length > 0) {
        parts.push(`[${f.optionLabels.map((l) => `"${l}"`).join(", ")}]`);
      }
    }
    return `  - ${parts.join(" ")}`;
  });
  const formFieldsBlock =
    s.formFields.length === 0
      ? "  (no form fields parsed from the HTML)"
      : fieldLines.join("\n") +
        (s.formFields.length > 25
          ? `\n  ...and ${s.formFields.length - 25} more`
          : "");

  // Short-option dropdowns: any <select> with 2–5 options is a candidate
  // for replacing with a visible radio-button / tick-box group, which
  // exposes all the choices without the user having to click open the
  // dropdown. 3–4 options is the sweet spot. We surface these
  // separately in GROUND TRUTH so Claude flags them — specifically when
  // they appear in the HERO / above-the-fold form, which is where the
  // friction matters most.
  const shortDropdowns = s.formFields.filter(
    (f) =>
      f.tag === "select" &&
      typeof f.optionCount === "number" &&
      f.optionCount !== null &&
      f.optionCount >= 2 &&
      f.optionCount <= 5,
  );
  const shortDropdownsBlock = shortDropdowns
    .slice(0, 6)
    .map((f) => {
      const id = f.name ?? f.id ?? "(unnamed)";
      const labels =
        f.optionLabels && f.optionLabels.length > 0
          ? ` — options: ${f.optionLabels.map((l) => `"${l}"`).join(", ")}`
          : "";
      return `  - <select> ${id} — ${f.optionCount} options${labels}`;
    })
    .join("\n");

  // Per-<form> breakdown so Claude knows exactly which fields belong to
  // which form. Position labels (early / middle / late) come from the
  // form's byte offset in the HTML, giving Claude a "hero vs bottom"
  // hint without having to guess from the screenshot.
  const formsBlock = s.forms
    .map((f) => {
      const positionLabel =
        f.position === "early"
          ? "early in the page (likely hero / above-the-fold)"
          : f.position === "late"
          ? "late in the page (likely bottom / footer area)"
          : "middle of the page";
      const fieldSummary =
        f.fields.length === 0
          ? "(no fields detected inside this <form>)"
          : f.fields
              .slice(0, 12)
              .map((field) => {
                const parts: string[] = [`<${field.tag}>`];
                if (field.type) parts.push(`type="${field.type}"`);
                if (field.name) parts.push(`name="${field.name}"`);
                if (field.placeholder) parts.push(`placeholder="${field.placeholder}"`);
                if (
                  field.tag === "select" &&
                  typeof field.optionCount === "number"
                ) {
                  parts.push(`options=${field.optionCount}`);
                }
                return `      • ${parts.join(" ")}`;
              })
              .join("\n");
      const cta = f.submitLabel ? ` (submit: "${f.submitLabel}")` : "";
      return `  - Form #${f.index + 1} — ${positionLabel}, ${f.fields.length} field${f.fields.length === 1 ? "" : "s"}${cta}:\n${fieldSummary}`;
    })
    .join("\n");

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
    "- Form fields on the page (tag + attributes, flat list across all forms):",
    formFieldsBlock,
    "",
    `- <form> elements detected on the page, in document order: ${s.forms.length}`,
    s.forms.length > 0 ? formsBlock : "  (no <form> tags found — fields may be wrapped in <div> with JS handlers; defer to the screenshot to identify forms)",
    "- IMPORTANT — anti-hallucination rule for forms:",
    "    When describing what fields a SPECIFIC form has (hero form, bottom form, footer form, etc.), the fields you name MUST appear in the per-<form> breakdown above for that form's position. Do NOT invent fields like 'first name', 'last name', 'company name', 'phone' if those fields aren't listed for the form you're describing. If the bottom form has 1 email input, say 'a one-field email form', not 'a full lead-gen form with first name, last name, company, and email'. If the page has zero <form> tags but you can clearly see a form in the screenshot, describe it from the screenshot but flag that the HTML couldn't confirm it.",
    "",
    `- Short-option dropdowns found on the page (2–5 options each): ${shortDropdowns.length}`,
    shortDropdowns.length > 0 ? shortDropdownsBlock : "  (none)",
    "- NOTE: any recommendation about converting a short-option dropdown into a visible radio-button / tick-box group belongs in the CRO dimension only, NOT in Above-the-fold. The CRO criteria document explains when this applies.",
    "",
    "- Navigation: DO NOT comment on, count, list, praise, or recommend changes to the page's navigation. Navigation analysis is OFF-LIMITS because static HTML extraction of nav links is unreliable on modern landing pages. Skip the topic entirely in every dimension — including Above-the-fold.",
    "",
    `- Total <img> elements on the page: ${s.imgCount}`,
    `- Images missing alt text: ${s.imgMissingAlt}`,
    `- Image formats (deduped by URL across <img>, srcset, and CSS url()):`,
    s.imageFormats.png > 0 ? `    PNG: ${s.imageFormats.png}` : "",
    s.imageFormats.jpeg > 0 ? `    JPEG: ${s.imageFormats.jpeg}` : "",
    s.imageFormats.gif > 0 ? `    GIF: ${s.imageFormats.gif}` : "",
    s.imageFormats.webp > 0 ? `    WebP: ${s.imageFormats.webp}` : "",
    s.imageFormats.avif > 0 ? `    AVIF: ${s.imageFormats.avif}` : "",
    s.imageFormats.svg > 0 ? `    SVG: ${s.imageFormats.svg}` : "",
    `    Legacy raster total (PNG+JPEG+GIF): ${s.imageFormats.legacyRaster}`,
    `    Modern raster total (WebP+AVIF): ${s.imageFormats.modernRaster}`,
    s.imageAlts.length > 0
      ? `- Image alt text (verbatim, up to 20 shown): ${s.imageAlts.slice(0, 20).map((a) => `"${a}"`).join(", ")}`
      : "- Image alt text: (none captured)",
    "",
    `- Social proof throughout the page (full-site HTML scan): ${s.socialProofPresent ? "YES" : "NO"}`,
    "  This is deterministic: we found trust markers (Trusted by / G2 / customer counts / case studies / testimonials / named brands) or 3+ brand-like image alts somewhere on the page. If this is YES, do NOT under any circumstances recommend adding social proof anywhere on the page — it is already on the page.",
    "",
    "- Above-the-fold social proof (judge from the screenshots): YOU determine this from the attached AtF screenshots. If you see ANY logos, trust line, ratings, badges, named-customer brands, or 'Trusted by N' copy visible inside the AtF viewport — including a logo strip cropped at the bottom edge of the hero — the answer is YES and social proof IS above the fold. Only answer NO when the AtF viewport is genuinely free of trust markers. Do NOT use any HTML-position heuristic for this — the screenshot is the only authority.",
    "  WHEN ABOVE-THE-FOLD SOCIAL PROOF = YES: do NOT say social proof is missing / appears below the fold / should be moved into the hero. Score the page positively for it.",
    "  WHEN ABOVE-THE-FOLD SOCIAL PROOF = NO but throughout-the-page = YES: you may suggest surfacing the existing social proof higher, but phrase it carefully and never claim the page has no social proof.",
    "",
    `- Above-the-fold contains interactive controls (checkbox / radio / quiz / multi-step): ${s.hasInteractiveAboveFold ? "YES" : "NO"}`,
    "- IMPORTANT: If 'interactive controls' is YES, the page is intentionally leading with an interactive flow (quiz, qualifier, multi-step form) where the CTA is the next step in the interaction. Treat this as a GOOD above-the-fold pattern. Do NOT say the hero is static, boring, lacks interactivity, or is missing a primary CTA — the interactive control IS the primary CTA. Score the above-the-fold dimension on the quality of the interaction, not on the absence of a traditional headline + button layout.",
    "",
    `- Page appears to be client-rendered with no server HTML (SPA shell): ${s.isClientRenderedShell ? "YES" : "NO"}`,
    "- IMPORTANT: If the SPA shell flag is YES, the HTML returned by our server-side fetch was a thin JavaScript-only shell. All ground-truth flags derived from the raw HTML (social proof presence, interactive controls, image alts, body-text excerpts, form fields) may UNDERREPORT what's actually on the rendered page. The SCREENSHOTS are rendered by a real browser and DO show the live page — trust the screenshots over the HTML-derived flags on this page. Specifically: if the screenshot clearly shows logos / testimonials / quizzes / forms that the ground-truth flags say are absent, the screenshot is correct and the flags are wrong.",
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
    bodyTextCharLimit >= 60_000
      ? "Body text of the FULL page (top to bottom, may be lightly truncated):"
      : `Body text of the page (first ~${Math.round(bodyTextCharLimit / 1000)},000 chars — the visible above-the-fold + nearby content):`,
    "---",
    input.bodyText.slice(0, bodyTextCharLimit),
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
