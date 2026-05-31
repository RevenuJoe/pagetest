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
import {
  computeMasterGroundTruth,
  formatGroundTruthFull,
  attachVisualGroundTruth,
  type MasterGroundTruth,
} from "./groundTruth";
import { runVisualGroundTruthPass } from "./visualGroundTruth";

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
  /** Precomputed master ground-truth object (HTML + PSI + vision pre-pass
   *  merged). When present, helpers prefer this over recomputing from
   *  `structure` on every call. Populated by `analyzeWithClaude` after
   *  the vision pre-pass runs. */
  master?: MasterGroundTruth;
  /** When true, collect every critic verdict (KEEP / REWRITE / DROP per
   *  candidate item, with reason and before/after text) and return them
   *  in the output. Used by `/api/analyze?debug=1` to inspect what the
   *  Phase 5 critic dropped or rewrote on a given run. */
  debug?: boolean;
}

/** One entry in the debug log of critic verdicts. */
export interface CriticVerdictDebugEntry {
  /** "dimensions" (Phase 4 dims-critic) or "takeaways" (Phase 5). */
  scope: "dimensions" | "takeaways";
  kind: "headline" | "note" | "takeaway";
  dim: ClaudeDimension | "speed";
  decision: "KEEP" | "REWRITE" | "DROP";
  before: string;
  /** Rewritten text when decision is REWRITE; undefined otherwise. */
  after?: string;
  /** Short reason the critic emitted; may be undefined. */
  reason?: string;
}

/** One drop from the deterministic regex filter. */
export interface FilterDropEntry {
  text: string;
  reason: string;
}

/** When the filter rewrote a headline (trimmed a clause or blanked it). */
export interface HeadlineCleanupEntry {
  before: string;
  after: string;
  reason: string;
}

/** Per-dimension trace through every pipeline stage. */
export interface DimensionTrace {
  /** Phase 3: raw output from the dim Claude call, before any cleanup. */
  raw: CheckResult;
  /** Phase 3b: notes dropped by the deterministic regex filter, with reasons. */
  filterDrops: FilterDropEntry[];
  /** Phase 3b: headline rewrite (trim) or blank, if any. */
  headlineCleanup: HeadlineCleanupEntry | null;
  /** Phase 3b: dim state after filter. */
  afterFilter: CheckResult;
  /** Phase 4 (dims-critic): per-item KEEP/REWRITE/DROP verdicts. */
  criticVerdicts: CriticVerdictDebugEntry[];
  /** Phase 4: dim state after critic. */
  afterCritic: CheckResult;
  /** Phase 6 (contradiction sweep): dim state in the final report. */
  afterSweep: CheckResult;
}

/** Wall-clock duration captured for each phase of the analyse run, in
 *  milliseconds. Used by the Stage Trace UI to highlight which phases
 *  cost the most time on a given page so we can target speedups. */
export interface PhaseTimings {
  /** Phase 2: vision pre-pass Claude call. Null when pre-pass didn't run. */
  visionPrepassMs: number | null;
  /** Phase 3: one entry per dim. Captures the per-call duration even
   *  though the five fire in parallel — useful for spotting an
   *  outlier dim that consistently takes longer than the others. */
  dimsMs: Record<ClaudeDimension, number>;
  /** Phase 3b: deterministic filter + headline cleanup across all 5
   *  dims, total. Usually under 5ms. */
  dimFilterMs: number;
  /** Phase 4: takeaways Claude call (runs in parallel with dims-critic). */
  takeawaysMs: number;
  /** Phase 4: dims-critic Claude call with extended thinking. */
  dimsCriticMs: number;
  /** Phase 4b: takeaways filter, deterministic. */
  takeawaysFilterMs: number;
  /** Phase 5: takeaways-critic Claude call. */
  takeawaysCriticMs: number;
  /** Phase 6: contradiction sweep, deterministic. */
  contradictionSweepMs: number;
  /** Total wall-clock inside analyzeWithClaude (Phase 2 onwards). The
   *  route can attach its own Phase 0 / 1 timings to this. */
  totalAnalyzeMs: number;
}

/** Trace through the takeaways pipeline (the parallel Claude call). */
export interface TakeawaysTrace {
  /** Phase 4 (Takeaways call): raw output before any cleanup. */
  raw: KeyTakeaway[];
  /** Phase 4b: dropped by the regex filter with reasons. */
  filterDrops: FilterDropEntry[];
  /** Phase 4b: takeaways after the filter. */
  afterFilter: KeyTakeaway[];
  /** Phase 5 (takeaways-critic): per-item verdicts. */
  criticVerdicts: CriticVerdictDebugEntry[];
  /** Phase 5: takeaways after the critic. */
  afterCritic: KeyTakeaway[];
  /** Phase 6: takeaways after the contradiction sweep. */
  afterSweep: KeyTakeaway[];
}

/** Full per-stage trace of one analyse run. Returned only when
 *  input.debug is set so the UI's "Stage trace" section can render
 *  the content created at each stage AND what was taken out at each
 *  stage with reasons. Used to spot weak points and tune the pipeline. */
export interface DebugTrace {
  /** Phase 2 (vision pre-pass): raw JSON facts the pre-pass extracted
   *  from the screenshots. `null` if the pre-pass failed or wasn't run. */
  vision: import("./groundTruth").VisualGroundTruth | null;
  /** Per-dimension trace, keyed by dim. */
  dimensions: Record<ClaudeDimension, DimensionTrace>;
  /** Takeaways trace. */
  takeaways: TakeawaysTrace;
  /** Phase 6 (contradiction sweep): drops with topic + origin. */
  contradictionSweep: {
    drops: Array<{
      origin: ClaudeDimension | "takeaway";
      topic: string;
      text: string;
    }>;
  };
  /** Per-phase wall-clock durations in milliseconds. */
  timings: PhaseTimings;
}

export type ClaudeChecks = Pick<
  Record<CheckKey, CheckResult>,
  "content" | "digestibility" | "cro" | "aboveTheFold" | "mobile"
>;

export interface ClaudeOutput {
  checks: ClaudeChecks;
  /** Top 5 categorised, page-specific takeaways. */
  keyTakeaways: KeyTakeaway[];
  /** Populated only when `input.debug === true`. Lists every critic
   *  verdict across both critic passes so callers can inspect what
   *  Phase 5 dropped / rewrote. */
  criticVerdicts?: CriticVerdictDebugEntry[];
  /** Populated only when `input.debug === true`. Full per-stage trace
   *  capturing the content created at each phase AND what was taken
   *  out at each phase with reasons. */
  debugTrace?: DebugTrace;
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

  // Per-phase timing accumulator. Used only when input.debug is true,
  // but bookkeeping is so cheap we just always populate it.
  const tAnalyzeStart = Date.now();
  const timeDimMs: Record<ClaudeDimension, number> = {
    content: 0,
    digestibility: 0,
    cro: 0,
    aboveTheFold: 0,
    mobile: 0,
  };

  // Phase 0: VISION PRE-PASS. One small Claude call against the
  // screenshots that produces deterministic visual facts (nav
  // worksheet, hero pattern, AtF social proof, mid-page CTA layout,
  // bottom form visible, hero headline visible). These go into the
  // GROUND TRUTH block as authoritative flags so the five dim calls
  // never have to interpret pixels themselves. Non-fatal: on any
  // failure we get null and the dim prompts fall back to their
  // "decide visually" rules.
  const tVisionStart = Date.now();
  const visualGT = await runVisualGroundTruthPass(
    client,
    input.desktopScreenshotB64,
    input.desktopFullPageB64,
    input.mobileScreenshotB64,
  );
  const visionPrepassMs = Date.now() - tVisionStart;
  const masterGT: MasterGroundTruth = (() => {
    const base = computeMasterGroundTruth({
      url: input.url,
      title: input.title,
      metaDescription: input.metaDescription,
      structure: input.structure,
    });
    return visualGT ? attachVisualGroundTruth(base, visualGT) : base;
  })();
  // Attach the master GT object onto the input so callDimension /
  // callTakeaways / runCriticPass can pull the vision-augmented
  // formatter output instead of recomputing the master object every
  // call. Each helper uses input.master via buildPromptText below.
  const inputWithMaster: ClaudeInput = { ...input, master: masterGT };

  // Phase 1: fan out the 5 DIMENSION calls in parallel. Each call sees
  // the page evidence and returns its own { score, headline, notes }.
  // Each individual dim call is wrapped with a stopwatch so we can
  // spot outlier dims that consistently run longer than the others.
  const timedDim = async (dim: ClaudeDimension) => {
    const t = Date.now();
    const result = await callDimension(client, inputWithMaster, dim);
    timeDimMs[dim] = Date.now() - t;
    return result;
  };
  const [contentRaw, digestibilityRaw, croRaw, aboveTheFoldRaw, mobileRaw] =
    await Promise.all([
      timedDim("content"),
      timedDim("digestibility"),
      timedDim("cro"),
      timedDim("aboveTheFold"),
      timedDim("mobile"),
    ]);

  // Phase 1b: deterministic filtering. Run every dimension's notes
  // through the hallucination filter BEFORE takeaways sees them, so
  // a bad note can't propagate from a dimension to the takeaways list.
  // Each call returns the cleaned result PLUS the list of drops (with
  // reasons) and any headline cleanup info, so the debug trace can
  // surface exactly what was removed at this stage.
  const tDimFilterStart = Date.now();
  const contentF = filterDimensionResult(contentRaw, "content", filterCtx);
  const digestibilityF = filterDimensionResult(digestibilityRaw, "digestibility", filterCtx);
  const croF = filterDimensionResult(croRaw, "cro", filterCtx);
  const aboveTheFoldF = filterDimensionResult(aboveTheFoldRaw, "aboveTheFold", filterCtx);
  const mobileF = filterDimensionResult(mobileRaw, "mobile", filterCtx);
  const dimFilterMs = Date.now() - tDimFilterStart;
  const content = contentF.result;
  const digestibility = digestibilityF.result;
  const cro = croF.result;
  const aboveTheFold = aboveTheFoldF.result;
  const mobile = mobileF.result;

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
  const tDimsCriticStart = Date.now();
  let dimsCriticMs = 0;
  // PER-DIM PARALLEL CRITIC. We used to send ALL dim candidates
  // (~25-40 items across 5 dims) to a single dims-critic call with
  // extended thinking. On larger reports that single call sat
  // reasoning for 60-80 seconds, dominating the entire request
  // wall-clock. Splitting into 5 parallel calls (one per dim) keeps
  // the same extended-thinking accuracy budget per item but brings
  // wall-clock down to roughly the slowest single dim ~15-25s. We
  // lose the rare cross-dimension consistency catches the batched
  // critic could spot, but the deterministic contradiction sweep in
  // Phase 6 handles the obvious cross-dim "recommend adding X / X
  // already present" pattern.
  //
  // Each per-dim call runs through the same runCriticPass code path
  // with scope="dimensions", so each still gets extended thinking
  // and the same critic prompt. We just hand it a one-dim slice of
  // the candidate set. The function's existing try/catch returns the
  // un-audited input if a per-dim call fails, so one slow dim can't
  // take the whole report down — at worst that dim ships un-audited.
  const dimensionsCriticPromise = Promise.all(
    CLAUDE_DIMS.map((dim) =>
      runCriticPass(
        client,
        inputWithMaster,
        { [dim]: dimensionResultsAfterFilter[dim] } as Record<
          ClaudeDimension,
          CheckResult
        >,
        [],
        "dimensions",
      ),
    ),
  ).then((perDimResults) => {
    dimsCriticMs = Date.now() - tDimsCriticStart;
    // Merge the 5 per-dim results into the shape the rest of the
    // pipeline expects (one combined record + concatenated verdict
    // log). Start from the post-filter state so any dim whose
    // critic call failed silently falls back to its un-audited
    // version (each per-dim runCriticPass already returns the
    // input record on error, but we belt-and-brace here).
    const merged: {
      dimensions: Record<ClaudeDimension, CheckResult>;
      takeaways: KeyTakeaway[];
      verdicts: CriticVerdictDebugEntry[];
    } = {
      dimensions: { ...dimensionResultsAfterFilter },
      takeaways: [],
      verdicts: [],
    };
    for (let i = 0; i < CLAUDE_DIMS.length; i++) {
      const dim = CLAUDE_DIMS[i];
      const r = perDimResults[i];
      if (r.dimensions[dim]) merged.dimensions[dim] = r.dimensions[dim];
      merged.verdicts.push(...r.verdicts);
    }
    return merged;
  });
  const tTakeawaysStart = Date.now();
  const takeawaysPromise = callTakeaways(
    client,
    inputWithMaster,
    dimensionResultsAfterFilter,
  );

  // As soon as Takeaways comes back, filter it and kick off the
  // takeaways-critic. The dims-critic may still be running — both
  // critics now race to completion. The takeaways-critic has a much
  // smaller candidate list so it's typically the faster of the two.
  const rawTakeaways = await takeawaysPromise;
  const takeawaysMs = Date.now() - tTakeawaysStart;
  const tTakeawaysFilterStart = Date.now();
  const takeawaysFilterResult = filterTakeaways(rawTakeaways, filterCtx);
  const takeawaysFilterMs = Date.now() - tTakeawaysFilterStart;
  const filteredTakeaways = takeawaysFilterResult.kept;
  const tTakeawaysCriticStart = Date.now();
  let takeawaysCriticMs = 0;
  const takeawaysCriticPromise = runCriticPass(
    client,
    inputWithMaster,
    dimensionResultsAfterFilter,
    filteredTakeaways,
    "takeaways",
  ).then((r) => {
    takeawaysCriticMs = Date.now() - tTakeawaysCriticStart;
    return r;
  });

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
  const tSweepStart = Date.now();
  const swept = runContradictionSweep(
    sweepInput,
    audited.takeaways,
    input.url,
    { socialProofPresent: input.structure.socialProofPresent },
  );
  const contradictionSweepMs = Date.now() - tSweepStart;

  // Rebuild dimensions in the original ClaudeChecks shape (the sweep
  // returned a generic record; pull the 5 Claude dimensions back out).
  const finalDimensions = {
    content: swept.dimensions.content ?? audited.dimensions.content,
    digestibility: swept.dimensions.digestibility ?? audited.dimensions.digestibility,
    cro: swept.dimensions.cro ?? audited.dimensions.cro,
    aboveTheFold: swept.dimensions.aboveTheFold ?? audited.dimensions.aboveTheFold,
    mobile: swept.dimensions.mobile ?? audited.dimensions.mobile,
  };

  // Combine the per-pass verdict logs into one ordered list (dims-critic
  // entries first, takeaways-critic second). Returned to the caller only
  // when input.debug is set; otherwise dropped on the floor.
  const criticVerdicts: CriticVerdictDebugEntry[] = [
    ...dimensionsCriticResult.verdicts,
    ...takeawaysCriticResult.verdicts,
  ];

  // Build the FULL per-stage debug trace when input.debug is set. This
  // captures the content at every stage of the pipeline (raw dim
  // output, after-filter, after-critic, after-sweep) AND the list of
  // things that were removed at each stage with the reason. The
  // payload is included in the API response so the report UI can
  // render a "Stage trace" inspector for tuning the pipeline.
  let debugTrace: DebugTrace | undefined;
  if (input.debug) {
    const filterMap = {
      content: contentF,
      digestibility: digestibilityF,
      cro: croF,
      aboveTheFold: aboveTheFoldF,
      mobile: mobileF,
    } as const;
    const rawMap: Record<ClaudeDimension, CheckResult> = {
      content: contentRaw,
      digestibility: digestibilityRaw,
      cro: croRaw,
      aboveTheFold: aboveTheFoldRaw,
      mobile: mobileRaw,
    };
    const dimVerdictsByDim: Record<string, CriticVerdictDebugEntry[]> = {};
    for (const v of dimensionsCriticResult.verdicts) {
      const key = v.dim;
      if (!dimVerdictsByDim[key]) dimVerdictsByDim[key] = [];
      dimVerdictsByDim[key].push(v);
    }
    const dims: DebugTrace["dimensions"] = {} as DebugTrace["dimensions"];
    for (const dim of CLAUDE_DIMS) {
      const f = filterMap[dim];
      dims[dim] = {
        raw: rawMap[dim],
        filterDrops: f.drops,
        headlineCleanup: f.headlineCleanup,
        afterFilter: f.result,
        criticVerdicts: dimVerdictsByDim[dim] ?? [],
        afterCritic: dimensionsCriticResult.dimensions[dim],
        afterSweep: finalDimensions[dim],
      };
    }
    debugTrace = {
      vision: masterGT.vision ?? null,
      dimensions: dims,
      takeaways: {
        raw: rawTakeaways,
        filterDrops: takeawaysFilterResult.drops,
        afterFilter: filteredTakeaways,
        criticVerdicts: takeawaysCriticResult.verdicts,
        afterCritic: takeawaysCriticResult.takeaways,
        afterSweep: swept.takeaways,
      },
      contradictionSweep: {
        drops: swept.drops,
      },
      timings: {
        visionPrepassMs,
        dimsMs: timeDimMs,
        dimFilterMs,
        takeawaysMs,
        dimsCriticMs,
        takeawaysFilterMs,
        takeawaysCriticMs,
        contradictionSweepMs,
        totalAnalyzeMs: Date.now() - tAnalyzeStart,
      },
    };
  }

  return {
    checks: finalDimensions,
    keyTakeaways: swept.takeaways,
    ...(input.debug ? { criticVerdicts, debugTrace } : {}),
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
  /** Per-candidate verdict log. Always populated; callers ignore it
   *  unless input.debug is set. */
  verdicts: CriticVerdictDebugEntry[];
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
    return { dimensions: dimensionResults, takeaways, verdicts: [] };
  }

  // Debug log accumulator. Filled as we walk the verdicts below.
  const debugLog: CriticVerdictDebugEntry[] = [];
  const debugScope: "dimensions" | "takeaways" =
    scope === "takeaways" ? "takeaways" : "dimensions";

  // Build the critic prompt + user blocks (same evidence the generators
  // had, plus the candidate list).
  const system = buildCriticPrompt();
  const userBlocks = buildUserBlocks(input);
  userBlocks.push({ type: "text", text: formatCandidateList(candidates) });

  let verdicts: CriticVerdict[] = [];
  try {
    // Extended thinking is enabled ONLY on the dimensions-critic pass
    // (scope === "dimensions"). The dims-critic audits the bigger
    // candidate list — five dimensions × headline + ~3 notes each =
    // up to 20 items — so a private 2500-token chain-of-thought
    // produces meaningfully better verdicts than a one-shot pass.
    //
    // The takeaways-critic gets a shorter candidate list (max 5
    // takeaways) and stays at plain temperature 0 — the cost of
    // thinking on both passes was prohibitive (roughly doubled the
    // critic's wall-clock).
    //
    // Trade-offs for the dims-critic:
    //   - temperature MUST be 1 with thinking enabled.
    //   - max_tokens must accommodate thinking budget + output. 2500
    //     thinking + 4000 output = 6500.
    //   - Wall-clock latency: dims-critic ~30s -> ~45-50s, but runs
    //     in parallel with the Takeaways call so the net report-time
    //     impact is usually small.
    // SDK 0.27 doesn't type the `thinking` field — we pass it via a
    // typed cast. Runtime API supports it on Claude Sonnet 4-5.
    const enableThinking = scope === "dimensions";
    const baseParams: Parameters<Anthropic["messages"]["create"]>[0] = enableThinking
      ? ({
          model: MODEL,
          max_tokens: 6500,
          temperature: 1,
          thinking: { type: "enabled", budget_tokens: 2500 },
          system,
          messages: [{ role: "user", content: userBlocks }],
        } as Parameters<Anthropic["messages"]["create"]>[0])
      : {
          model: MODEL,
          max_tokens: 4000,
          temperature: 0,
          system,
          messages: [{ role: "user", content: userBlocks }],
        };
    const response = await createWithRetry(
      client,
      baseParams,
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
    return { dimensions: dimensionResults, takeaways, verdicts: [] };
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
          debugLog.push({ scope: debugScope, kind: "headline", dim, decision: "DROP", before: cand.text, reason: v.reason });
        } else if (v?.decision === "REWRITE" && v.text) {
          newHeadline = scrubEmDashes(v.text);
          console.warn(`[critic] REWRITE headline dim="${dim}" reason="${v.reason ?? ""}" before="${cand.text}" after="${v.text}"`);
          debugLog.push({ scope: debugScope, kind: "headline", dim, decision: "REWRITE", before: cand.text, after: v.text, reason: v.reason });
        } else {
          debugLog.push({ scope: debugScope, kind: "headline", dim, decision: "KEEP", before: cand.text });
        }
      } else if (cand.kind === "note") {
        if (v?.decision === "DROP") {
          console.warn(`[critic] DROP note dim="${dim}" reason="${v.reason ?? ""}" text="${cand.text}"`);
          debugLog.push({ scope: debugScope, kind: "note", dim, decision: "DROP", before: cand.text, reason: v.reason });
        } else if (v?.decision === "REWRITE" && v.text) {
          newNotes.push(scrubEmDashes(v.text));
          console.warn(`[critic] REWRITE note dim="${dim}" reason="${v.reason ?? ""}" before="${cand.text}" after="${v.text}"`);
          debugLog.push({ scope: debugScope, kind: "note", dim, decision: "REWRITE", before: cand.text, after: v.text, reason: v.reason });
        } else {
          newNotes.push(cand.text);
          debugLog.push({ scope: debugScope, kind: "note", dim, decision: "KEEP", before: cand.text });
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
      debugLog.push({ scope: debugScope, kind: "takeaway", dim: cand.dim, decision: "DROP", before: cand.text, reason: v.reason });
      return;
    }
    if (v?.decision === "REWRITE" && v.text) {
      newTakeaways.push({ ...tk, text: scrubEmDashes(v.text) });
      console.warn(`[critic] REWRITE takeaway reason="${v.reason ?? ""}" before="${cand.text}" after="${v.text}"`);
      debugLog.push({ scope: debugScope, kind: "takeaway", dim: cand.dim, decision: "REWRITE", before: cand.text, after: v.text, reason: v.reason });
      return;
    }
    newTakeaways.push(tk);
    debugLog.push({ scope: debugScope, kind: "takeaway", dim: cand.dim, decision: "KEEP", before: cand.text });
  });

  return { dimensions: newDimensions, takeaways: newTakeaways, verdicts: debugLog };
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
    "  - DROP or REWRITE any item that quotes a SPECIFIC hero headline when the quoted text is NOT the headline visible at the top of the above-the-fold screenshot. The page may have many <h1> elements in different sections; the hero headline is only the one rendered AT THE TOP of the AtF viewport. If the candidate quotes one of the other <h1>s (e.g. the bottom CTA section's heading) as the hero, that's a hallucination — drop the quote or rewrite to describe the hero without a specific quote.",
    "  - HEADLINE-MUST-SUMMARISE-NOTES check: when auditing a HEADLINE candidate, look at all the NOTE candidates from the SAME dimension. Every topic mentioned in the headline must be supported by at least one note. If the headline mentions a topic (e.g. 'bottom CTA', 'mid-page conversion paths', 'social proof', 'mobile layout') that NO note in the same dimension discusses, REWRITE the headline to remove that clause. The headline is a summary of the notes, not a standalone claim. Worked failure mode: headline says 'Strong hero form and bottom CTA, but mid-page conversion paths are sparse' while the notes only discuss the hero form and the dropdown — 'bottom CTA' and 'mid-page conversion paths' have no supporting note. Rewrite to drop those unsupported clauses.",
    "  - HEADLINE-SIMILARITY check across dimensions: scan all HEADLINE candidates together. If two dimension headlines lead with the SAME topic or repeat the same descriptive phrase (e.g. one says 'Strong hero form with qualifying question' and another says 'Strong hero form with qualifying dropdown'), REWRITE one of them so each dimension's headline reads as a distinct take. The headlines should reflect what's UNIQUE to each dimension's perspective: Above-the-fold is about visual hierarchy and what the visitor sees first; CRO is about conversion design and CTA strategy; Content is about copy and messaging. Never let two headlines feel like restatements of the same idea — the reader is meant to learn something different from each dimension. Bias toward rewriting the WEAKER duplicate (less specific, less concrete) rather than the stronger one.",
    "  - HERO-FORM-CHANGE TEST-FRAMING rule: any takeaway, note, or headline that recommends CHANGING the hero form (dropdown -> tick boxes, one-field -> dropdown / tick boxes, big-form -> simpler widget) MUST be framed as an A/B test. If the candidate leads with 'Convert the…', 'Replace the…', 'Change the…', 'Switch the…', or any other definitive opener about a hero form change, REWRITE it to lead with 'Test converting…', 'A/B test…', 'Run an A/B test of…' instead. The variant might not win — the recommendation is to RUN A TEST, not to ship a fix. Worked failure mode: 'Convert the hero's dropdown form to four visible tick boxes' must become 'Test converting the hero's dropdown form to four visible tick boxes against the existing version' or 'A/B test 4-or-fewer tick boxes against the existing hero dropdown'. Same rule applies to recommendations that swap one form type for another (e.g. 'Replace the one-field email form with a multi-step quiz' → 'Test a multi-step quiz against the current one-field email form').",
    "  - ABOVE-THE-FOLD SCOPE rule: when auditing an aboveTheFold dimension candidate (headline or note), DROP it if it describes, praises, or critiques anything that lives BELOW the fold or further down the page. AtF only judges what's visible in the AtF viewport in the screenshots. Phrases like 'below the fold', 'further down the page', 'the product screenshot below the fold', 'the page also includes…', 'after the hero…', 'scrolling down reveals…' are out of scope for this dimension. If the candidate's substantive claim is about something inside the AtF viewport but uses one of those phrasings, REWRITE to remove the below-the-fold framing. If the entire note is about something below the fold, DROP it.",
    "  - BOTTOM-FORM PRESENCE rule: DROP or REWRITE any candidate (note, headline, or takeaway) that claims the page has 'no bottom form', 'no bottom lead-gen form', 'no bottom conversion form', or that 'a bottom form is missing' WHEN the per-<form> GROUND TRUTH list shows ANY form at 'late' or 'middle' position OR the full-page screenshot shows a form (even a one-field email input) above the footer. A one-field email form at the bottom IS a bottom lead-gen form for CRO scoring — it qualifies the page for the TOP + BOTTOM CONVERSION COMBO bonus. The claim contradicts the data; drop it. If the candidate's substantive point is something else (e.g. 'the bottom form could be stronger') but it uses the false 'no bottom form' framing, rewrite to remove the false claim while keeping the supportable observation.",
    "  - NAV COUNT rule (Above-the-fold dim only): any AtF candidate that comments on the nav MUST state the actual count of visible TEXT LINKS and BUTTONS from the AtF screenshot. The logo is not a text link, not a button — capture it as a yes/no fact only and do NOT lead with or dwell on it in the commentary. If the candidate calls the nav 'good' / 'clean' / 'lean' / 'balanced' / 'minimal' WITHOUT stating the text-link and button counts, REWRITE to include the counts or DROP if the counts contradict the praise. The ideal is 3 text links maximum (excluding logo and conversion buttons). If the candidate praises a nav that has 4 or more text links in the screenshot, that's WRONG — the rule is 4+ text links is too many. Rewrite or drop. Counts: logo doesn't count as a text link; obvious conversion buttons ('Get a Demo', 'Start Free Trial', 'Book a Demo' with coloured backgrounds) are counted separately from the text links.",
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

/**
 * Build the GROUND TRUTH + structural summary + body text string sent
 * to Claude dim / takeaways / critic calls.
 *
 * Task #86 refactor: the heavy lifting (CTA classification, long
 * heading detection, short dropdown filtering, per-form formatting,
 * the giant return string) moved into `lib/groundTruth.ts`. This
 * function is now a thin wrapper that builds the master ground-truth
 * object and asks the formatter for the full string. Output is
 * byte-identical to the pre-refactor version.
 *
 * Slicing the GT per dimension is Task #88 — the master object is
 * already structured to support that without further changes here.
 */
function buildPromptText(input: ClaudeInput, bodyTextCharLimit = 60_000): string {
  // Prefer the precomputed master object if `analyzeWithClaude` has
  // already populated it (which it always does in the live pipeline,
  // so the visual-GT facts get rendered into the prompt). Fall back
  // to computing fresh on the spot for tests and direct callers that
  // bypass the orchestration entry point.
  const master =
    input.master ??
    computeMasterGroundTruth({
      url: input.url,
      title: input.title,
      metaDescription: input.metaDescription,
      structure: input.structure,
    });
  return formatGroundTruthFull(master, input.bodyText, bodyTextCharLimit);
}


function parseDimension(raw: string): CheckResult {
  const parsed = parseJsonObject(raw);
  return {
    score: clampScore(parsed.score),
    headline: scrubEmDashes(
      typeof parsed.headline === "string" ? parsed.headline : "(no summary)",
    ),
    notes: Array.isArray(parsed.notes)
      ? parsed.notes
          .filter((x: unknown): x is string => typeof x === "string")
          .map((s) => scrubEmDashes(s))
          .slice(0, 3)
      : [],
  };
}

/**
 * Strip em dashes (—) and en dashes (–) from any string Claude returns.
 * Zero-tolerance policy on em-dashes in the report — they read as
 * AI-generated. We tell Claude not to use them, but as a deterministic
 * safety net every string that comes out of a Claude call passes
 * through this scrub before it reaches the user.
 *
 * Replacement strategy:
 *   - "X — Y"  becomes  "X, Y"      (em dash with spaces -> comma + space)
 *   - "X—Y"   becomes  "X, Y"      (em dash without spaces -> comma + space)
 *   - "X – Y"  becomes  "X, Y"      (en dash with spaces -> comma)
 *   - "X–Y"   becomes  "X-Y"       (en dash without spaces, e.g. number ranges, -> hyphen)
 * Adjacent whitespace is collapsed so we don't end up with double spaces.
 */
function scrubEmDashes(s: string): string {
  if (!s) return s;
  return s
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/–/g, "-")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
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
        const text = typeof obj.text === "string" ? scrubEmDashes(obj.text) : "";
        if (!text) return null;
        const category = VALID_CATEGORIES.includes(cat as CheckKey)
          ? (cat as CheckKey)
          : ("content" as CheckKey);
        return { category, text };
      }
      if (typeof it === "string" && it.trim().length > 0) {
        return { category: "content" as CheckKey, text: scrubEmDashes(it) };
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
