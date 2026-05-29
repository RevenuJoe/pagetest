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

  // Phase 2: now that the dimensions have concluded (and been filtered),
  // run the Takeaways call with each dimension's CLEAN notes injected
  // into the prompt as the SOURCE MATERIAL. Takeaways can only
  // summarise / re-prioritise what the dimensions already concluded —
  // it can't invent new observations.
  const dimensionResultsAfterFilter = { content, digestibility, cro, aboveTheFold, mobile };
  const rawTakeaways = await callTakeaways(client, input, dimensionResultsAfterFilter);

  // Phase 2b: deterministic filter on takeaways too, in case Claude
  // re-introduced a hallucination by rewording a dimension note.
  const filteredTakeaways = filterTakeaways(rawTakeaways, filterCtx);

  // Phase 3: GENERATOR-THEN-CRITIC fact-check. A single fresh Claude
  // call audits every headline, every note, and every takeaway against
  // the same evidence (GROUND TRUTH + body text + screenshots). For
  // each item the critic returns KEEP, REWRITE, or DROP. The deterministic
  // filters above catch known hallucination patterns; this call catches
  // the rest. It's the standard generate-then-verify pattern.
  const audited = await runCriticPass(
    client,
    input,
    dimensionResultsAfterFilter,
    filteredTakeaways,
  );

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
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    // Temperature 0 keeps output as deterministic as possible. Higher
    // temperatures invent more novel content — exactly what we don't
    // want for factual analysis of a specific page.
    temperature: 0,
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
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0,
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
): Promise<{
  dimensions: Record<ClaudeDimension, CheckResult>;
  takeaways: KeyTakeaway[];
}> {
  // Build the candidate list — every piece of generated text in the
  // report that the model produced (not deterministic content).
  const candidates: CandidateItem[] = [];
  let nextId = 1;
  for (const dim of CLAUDE_DIMS) {
    const r = dimensionResults[dim];
    if (r.headline && r.headline.trim().length > 0) {
      candidates.push({ id: nextId++, kind: "headline", dim, text: r.headline });
    }
    r.notes.forEach((note, idx) => {
      candidates.push({ id: nextId++, kind: "note", dim, noteIndex: idx, text: note });
    });
  }
  takeaways.forEach((tk, idx) => {
    const text = typeof tk === "string" ? tk : tk.text;
    const dim: ClaudeDimension | "speed" =
      typeof tk === "string" ? "content" : (tk.category as ClaudeDimension | "speed");
    candidates.push({ id: nextId++, kind: "takeaway", dim, takeawayIndex: idx, text });
  });

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
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      temperature: 0,
      system,
      messages: [{ role: "user", content: userBlocks }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    verdicts = parseCriticVerdicts(text);
  } catch (err) {
    // If the critic call fails, fall back to the un-audited results.
    // This keeps the tool working even if the critic API misbehaves.
    console.warn("Critic pass failed — returning un-audited results:", err);
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
