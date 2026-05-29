/**
 * Deterministic post-processing of Claude-generated notes.
 *
 * Each filter looks at a candidate note's text and the ground-truth
 * data we parsed from the page. If a note matches a known hallucination
 * pattern AND the ground truth contradicts the claim, the note is
 * dropped before it reaches the user.
 *
 * This is a safety net on top of the prompt rules. The prompt rules
 * reduce the volume of hallucinations the model emits; this filter
 * catches the ones that still slip through. New patterns get added
 * here as we observe them.
 *
 * Every drop is logged to console.warn so Vercel logs show exactly
 * what was filtered on each run.
 */

import type { PageStructure, FetchedPage } from "./fetchPage";
import type { CheckResult, KeyTakeaway } from "./types";
import type { ClaudeDimension } from "./scoringCriteria";

export interface FilterContext {
  structure: PageStructure;
  bodyText: string;
  url: string;
}

/** A filter looks at a note (and its dimension) and decides whether to
 *  drop it. Return a reason string to drop; return null to keep. */
type FilterRule = (
  note: string,
  dim: ClaudeDimension | "takeaways",
  ctx: FilterContext,
) => string | null;

// -----------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------

/** Indicators of social-proof anywhere in the page body. If ANY of these
 *  match the body text, the page demonstrably has social proof (logos,
 *  ratings, customer counts, badges). Notes claiming social proof is
 *  missing — anywhere, including "above the fold" — are unsafe. */
const SOCIAL_PROOF_BODY_PATTERNS: RegExp[] = [
  /\btrusted by\b/i,
  /\bused by\b/i,
  /\bloved by\b/i,
  /\b(rated|ranked|reviewed)\s+\d/i,
  /\b\d+(\.\d+)?\s*\/\s*(5|10)\b/i, // "4.8/5", "9/10"
  /\bg2\b/i,
  /\bcapterra\b/i,
  /\btrustpilot\b/i,
  /\bgartner\b/i,
  /\bforrester\b/i,
  /\b\d{2,}[+]?\s*(customers?|clients?|teams?|companies|brands?|hospitals?|practices?|users?|members?)\b/i,
  /\b\d+%\s+(of\s+)?(customers?|users?|teams?|companies)/i,
  /\bcase studies?\b/i,
  /\btestimonials?\b/i,
  /\breviews?\b/i,
];

function bodyHasSocialProof(bodyText: string): boolean {
  return SOCIAL_PROOF_BODY_PATTERNS.some((re) => re.test(bodyText));
}

// -----------------------------------------------------------------------
// FILTERS
// -----------------------------------------------------------------------

/** "Page lacks a nav entirely" / "no navigation present" / "nav is
 *  minimal" when the page actually has top-area nav content — either
 *  inside <header>, or via non-semantic markup (Unbounce-style <div>
 *  nav links detected via body-text scan). */
const filterNavMissingButHasContent: FilterRule = (note, _dim, ctx) => {
  const said =
    /\bpage\s+lacks\s+a\s+(<nav>|nav(igation)?)\s+(element\s+)?(entirely|altogether)\b/i.test(note) ||
    /\b(no|missing)\s+nav(igation)?\s+(present|element|whatsoever)\b/i.test(note) ||
    /\bpage\s+has\s+no\s+nav(igation)?\b/i.test(note) ||
    /\b(zero|no)\s+(<nav>|nav)\s+elements?\b/i.test(note) ||
    /\bnav(igation)?\s+is\s+minimal\b/i.test(note) ||
    /\b(add|need|missing|lack(s|ing)?)\b[^.]{0,80}\b(additional|more|extra)\s+nav(igation)?\s+(links?|items?)\b/i.test(note) ||
    /\bcould\s+benefit\s+from\b[^.]{0,80}\bnav(igation)?\s+(links?|items?)\b/i.test(note) ||
    /\bno\s+logo[- ]left\s*\+\s*links[- ]middle\s*\+\s*cta[- ]right\b/i.test(note);
  if (!said) return null;
  if (ctx.structure.headerCtaTexts.length > 0) {
    return `claims page has no/minimal navigation but <header> contains ${ctx.structure.headerCtaTexts.length} link(s)/button(s): ${ctx.structure.headerCtaTexts.slice(0, 4).join(", ")}`;
  }
  if (ctx.structure.likelyNavLabels.length >= 2) {
    return `claims page has no/minimal navigation but body text contains likely nav labels: ${ctx.structure.likelyNavLabels.slice(0, 5).join(", ")}`;
  }
  return null;
};

/** "Slim the nav" / "navigation is bulky" when the page has ≤4 nav
 *  links — verifiable false. Single nav (1 link) and zero nav (0 links)
 *  are different situations, not bulkiness. */
const filterNavBulky: FilterRule = (note, _dim, ctx) => {
  const said =
    /\bnav(igation)?\s+is\s+bulky\b/i.test(note) ||
    /\bbulky\s+nav(igation)?\b/i.test(note) ||
    /\bslim\s+(?:the\s+)?nav(igation)?\b/i.test(note) ||
    /\btoo\s+many\s+(?:nav|menu)\s+(?:links|items)\b/i.test(note) ||
    /\breduce\s+(?:the\s+)?(?:nav|menu|navigation)\s+(?:links|items)\b/i.test(note);
  if (!said) return null;
  const count = ctx.structure.navLinks.length;
  if (count <= 4) {
    return `nav-bulky claim but only ${count} nav links exist`;
  }
  return null;
};

/** Recommending "add social proof above the fold" when the page already
 *  has clear social-proof signals somewhere on it. The above-the-fold
 *  visual check is something we can't verify programmatically, but if
 *  the page has body-level social proof, a "missing" claim is unsafe
 *  enough to drop. */
const filterAddSocialProof: FilterRule = (note, _dim, ctx) => {
  const said =
    /(add|move|missing|lack|need|include)\b[^.]{0,80}\b(social proof|customer logos?|trust signals?|testimonials?|ratings?|reviews?)\b/i.test(
      note,
    ) ||
    /(no|without)\s+(visible\s+)?(social proof|customer logos?|trust signals?|testimonials?|ratings?)/i.test(
      note,
    );
  if (!said) return null;
  if (bodyHasSocialProof(ctx.bodyText)) {
    return "social-proof claimed missing/needed but page contains social-proof markers";
  }
  return null;
};

/** Recommending a bottom / final / footer form when the page has 2+
 *  forms (so one is almost certainly the bottom one). */
const filterAddBottomForm: FilterRule = (note, _dim, ctx) => {
  const said =
    /(add|missing|lack|need|no)\b[^.]{0,80}\b(bottom|final|footer|second|closing)\s+(form|cta\b|conversion widget)\b/i.test(
      note,
    ) ||
    /\b(form|cta\b|conversion widget)\s+at\s+the\s+bottom\b/i.test(note) && /(add|missing|lack|need|no)\b/i.test(note);
  if (!said) return null;
  if (ctx.structure.formCount >= 2) {
    return `bottom-form claim but page has ${ctx.structure.formCount} <form> elements`;
  }
  return null;
};

/** Recommending sign-in / log-in / create-account as a positive CTA.
 *  Our criteria explicitly say these are for existing users and we
 *  never want them suggested as a conversion lift. Drop unconditionally
 *  in any "add / include / consider / recommend" context. */
const filterSignInRecommendation: FilterRule = (note) => {
  const said =
    /(add|include|consider|recommend|missing|lack)\b[^.]{0,80}\b(sign[- ]?in|sign[- ]?up|log[- ]?in|create account)\b/i.test(
      note,
    ) ||
    /\b(sign[- ]?in|log[- ]?in)\s+(option|link|button|cta)\b/i.test(note);
  if (!said) return null;
  return "sign-in / log-in CTA recommended (we never want to recommend these)";
};

/** Phone-field commentary when GROUND TRUTH says no phone field. */
const filterPhoneFieldGhost: FilterRule = (note, _dim, ctx) => {
  const said = /\bphone(\s+number)?\s+field\b|\btel(\s+input)?\s+field\b|\bremove\s+the\s+phone\b/i.test(note);
  if (!said) return null;
  if (!ctx.structure.hasPhoneField) {
    return "phone-field commentary but GROUND TRUTH says no phone field exists";
  }
  return null;
};

/** "The bottom form should re-ask the hero's qualifying question" /
 *  "repeat the question-led pattern" / "strip fields to match the hero".
 *  These contradict the explicit hero != bottom form rule. */
const filterBottomFormShouldRepeat: FilterRule = (note) => {
  const said =
    /\b(re[- ]?ask|repeat|duplicate|carry)\b[^.]{0,80}\b(qualifying|hero|question[- ]?led)\b/i.test(
      note,
    ) ||
    /\bbottom\s+form\b[^.]{0,80}\b(re[- ]?ask|repeat|same|matching)\b/i.test(note) ||
    /\bstrip\b[^.]{0,80}\bfields\b[^.]{0,80}\b(bottom|hero)\b/i.test(note);
  if (!said) return null;
  return "bottom-form-should-repeat-hero-question (contradicts explicit two-form rule)";
};

/** "No CTA button visible" / "Missing CTA button" when ground truth
 *  shows the page has CTA-like buttons / links. */
const filterMissingCtaButton: FilterRule = (note, _dim, ctx) => {
  const said =
    /\b(no|missing|lack(s|ing)?|without)\b[^.]{0,80}\b(standalone\s+)?cta\s+button\b/i.test(note) ||
    /\bcta\s+button\b[^.]{0,80}\b(not\s+visible|missing|absent)\b/i.test(note) ||
    /\bno\s+(standalone\s+)?(call[- ]to[- ]action|cta)\b/i.test(note);
  if (!said) return null;
  // If we know the page has at least 2 CTA-like buttons/links, the
  // "no CTA" claim is unsafe.
  if (ctx.structure.ctaTexts.length >= 2) {
    return `missing-CTA-button claim but page has ${ctx.structure.ctaTexts.length} CTA labels parsed from HTML`;
  }
  return null;
};

/** "CTA not integrated with form" / "button is separate from form" /
 *  "button below the dropdown" framed as a negative. We never want to
 *  flag a stacked layout as a problem unless it genuinely hurts UX,
 *  and we have no way to verify that programmatically. Drop on sight. */
const filterNotIntegratedLayout: FilterRule = (note) => {
  const said =
    /\b(not|isn['’]?t)\s+integrated\b[^.]{0,80}\bform\b/i.test(note) ||
    /\bseparate\s+from\s+(the\s+)?form\b/i.test(note) ||
    /\bbutton\s+(is\s+)?below\s+(the\s+)?dropdown\b[^.]{0,80}\brather\s+than\s+integrated\b/i.test(
      note,
    ) ||
    /\brather\s+than\s+integrated\b[^.]{0,80}\bform\b/i.test(note);
  if (!said) return null;
  return "not-integrated layout claim (stacked layout isn't a UX problem)";
};

// -----------------------------------------------------------------------
// PIPELINE
// -----------------------------------------------------------------------

const ALL_FILTERS: FilterRule[] = [
  filterNavMissingButHasContent,
  filterNavBulky,
  filterAddSocialProof,
  filterAddBottomForm,
  filterSignInRecommendation,
  filterPhoneFieldGhost,
  filterBottomFormShouldRepeat,
  filterMissingCtaButton,
  filterNotIntegratedLayout,
];

/** Apply all filters to a single note. Returns the note (keep) or null
 *  (drop). Drops are logged to console.warn with the dimension and
 *  reason so Vercel logs surface the filtering activity. */
function applyFilters(
  note: string,
  dim: ClaudeDimension | "takeaways",
  ctx: FilterContext,
): { keep: true } | { keep: false; reason: string } {
  for (const rule of ALL_FILTERS) {
    const reason = rule(note, dim, ctx);
    if (reason) return { keep: false, reason };
  }
  return { keep: true };
}

/** Filter notes inside a dimension's CheckResult. The headline and
 *  score are untouched; only the notes array is rebuilt without dropped
 *  items. Returns the cleaned CheckResult (or the original if nothing
 *  was dropped). */
export function filterDimensionResult(
  result: CheckResult,
  dim: ClaudeDimension,
  ctx: FilterContext,
): CheckResult {
  const kept: string[] = [];
  for (const note of result.notes) {
    const verdict = applyFilters(note, dim, ctx);
    if (verdict.keep) {
      kept.push(note);
    } else {
      console.warn(
        `[noteFilter] DROP dim="${dim}" reason="${verdict.reason}" url="${ctx.url}" note="${note}"`,
      );
    }
  }
  if (kept.length === result.notes.length) return result;
  return { ...result, notes: kept };
}

/** Filter the Key Takeaways list. Each takeaway has a `text` field
 *  that gets scanned the same way dimension notes are. */
export function filterTakeaways(
  takeaways: KeyTakeaway[],
  ctx: FilterContext,
): KeyTakeaway[] {
  const kept: KeyTakeaway[] = [];
  for (const tk of takeaways) {
    const text = typeof tk === "string" ? tk : tk.text;
    const verdict = applyFilters(text, "takeaways", ctx);
    if (verdict.keep) {
      kept.push(tk);
    } else {
      console.warn(
        `[noteFilter] DROP takeaway reason="${verdict.reason}" url="${ctx.url}" text="${text}"`,
      );
    }
  }
  return kept;
}

/** Convenience: build a FilterContext from the page fetch + url. */
export function buildFilterContext(page: FetchedPage, url: string): FilterContext {
  return {
    structure: page.structure,
    bodyText: page.bodyText,
    url,
  };
}
