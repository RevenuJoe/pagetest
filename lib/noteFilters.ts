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

/**
 * Drop ANY note that comments on the page's navigation, whether the
 * comment is positive or negative. Joe's call: nav-link detection from
 * static HTML is unreliable on modern landing pages, and even
 * accurate-looking nav commentary (e.g. "navigation is lean with 4
 * links") risks being wrong on the next page. Nav is off-limits as a
 * topic.
 *
 * Pattern is broad on purpose. Matches:
 *   - "navigation", "nav bar", "nav links", "nav menu"
 *   - "the top menu", "header menu", "primary menu"
 *   - "links in the nav", "nav has N links"
 *   - "slim/lean/bulky/minimal navigation"
 *   - "logo-left + links-middle" layout descriptions
 *
 * Does NOT match notes that mention "navigate" as a verb in another
 * sense (e.g. "users navigate to the form"), because the patterns are
 * anchored to the noun forms / common nav phrasings.
 */
const filterAnyNavCommentary: FilterRule = (note) => {
  const said =
    /\bnav(igation)?\s+(is|has|carries|contains|holds|provides|offers|appears)\b/i.test(note) ||
    /\b(the|a|page'?s?)\s+nav(igation)?\b[^.]{0,30}\b(is|has|with|of|in)\b/i.test(note) ||
    /\bnav(?:igation)?\s+(?:bar|menu|links?|items?|elements?|structure|layout)\b/i.test(note) ||
    /\b(header|top|primary)\s+(?:nav|menu|navigation)\b/i.test(note) ||
    /\blinks?\s+(?:in|inside)\s+(?:the\s+)?nav(igation)?\b/i.test(note) ||
    /\bnav(igation)?\s+(?:lean|bulky|minimal|slim|tidy|clean|sparse|crowded|heavy|cluttered|cramped)\b/i.test(note) ||
    /\b(slim|trim|reduce|cut|expand|add)\b[^.]{0,40}\bnav(igation)?\b/i.test(note) ||
    /\blogo[- ]left\s*\+\s*links[- ]middle\b/i.test(note) ||
    /\bpage\s+lacks\s+a\s+(<nav>|nav(igation)?)\b/i.test(note);
  if (!said) return null;
  return "navigation commentary (off-limits topic — counts unreliable)";
};

/** Legacy filter kept for compatibility — superseded by
 *  filterAnyNavCommentary above, which catches the same cases plus
 *  positive nav commentary. */
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
  // Navigation is OFF-LIMITS as a topic — counts are unreliable on
  // modern landing pages. The broad filter below catches both
  // negative AND positive nav commentary.
  filterAnyNavCommentary,
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

/** Filter notes AND clean the headline inside a dimension's CheckResult.
 *  Notes that match a hallucination pattern are dropped. The headline
 *  goes through a similar check, but instead of being dropped it's
 *  trimmed (e.g. "Strong X, but lacks Y" → "Strong X") when the
 *  trailing clause is the hallucinating part. If trimming fails, the
 *  headline is blanked. Score and other fields are untouched. */
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
  const headline = cleanHeadline(result.headline, dim, ctx, kept);
  if (kept.length === result.notes.length && headline === result.headline) {
    return result;
  }
  return { ...result, headline, notes: kept };
}

/**
 * Clean a dimension's headline. Two checks:
 *
 *   1. Run all existing note filters against the headline. If any
 *      fires, try trimming the clause that introduces the
 *      hallucination (split on ", but" / " but " / "; however" /
 *      etc and keep the clean first half). If the trimmed version
 *      still fails a filter, blank the headline entirely.
 *
 *   2. Cross-check against the dimension's notes: if the headline
 *      claims X is missing but a note in the same dimension says X
 *      is present, that's a self-contradiction; trim or blank as
 *      above.
 *
 * Returns the cleaned headline (possibly empty).
 */
function cleanHeadline(
  headline: string,
  dim: ClaudeDimension | "takeaways",
  ctx: FilterContext,
  notesInDimension: string[],
): string {
  if (!headline) return headline;

  // 1) Direct filter match.
  const directReason = firstFilterHit(headline, dim, ctx);
  if (directReason) {
    const trimmed = trySplitHeadline(headline);
    if (trimmed && !firstFilterHit(trimmed, dim, ctx)) {
      console.warn(
        `[noteFilter] HEADLINE trim dim="${dim}" reason="${directReason}" url="${ctx.url}" before="${headline}" after="${trimmed}"`,
      );
      return trimmed;
    }
    console.warn(
      `[noteFilter] HEADLINE blank dim="${dim}" reason="${directReason}" url="${ctx.url}" original="${headline}"`,
    );
    return "";
  }

  // 2) Cross-check headline vs notes — the model's own observations
  //    can override its own misleading headline. Look for "lacks/no
  //    social proof" in the headline while a note says social proof
  //    is present. Same pattern for nav, CTAs, hero, FAQ.
  const headlineSaysMissing = (re: RegExp) => re.test(headline);
  const noteSaysPresent = (re: RegExp) =>
    notesInDimension.some((n) => re.test(n));

  const contradictions: Array<{ missing: RegExp; present: RegExp; label: string }> = [
    {
      missing: /\b(lack(s|ing)?|missing|no|without)\b[^.]{0,40}\bsocial\s+proof\b/i,
      present:
        /\b(visible|shows?|displays?|delivers?|provides?|has|includes?|features?)\b[^.]{0,60}\b(social\s+proof|customer\s+logos?|logos?)\b/i,
      label: "headline says social proof missing but a note says it's present",
    },
    {
      missing: /\b(lack(s|ing)?|missing|no|without)\b[^.]{0,40}\bnav(igation)?\b/i,
      present:
        /\b(visible|shows?|has|includes?|features?|with|contains?)\b[^.]{0,60}\bnav(igation)?\s+(?:links?|items?|menu|bar)\b/i,
      label: "headline says nav missing but a note describes nav links",
    },
    {
      missing: /\b(lack(s|ing)?|missing|no|without)\b[^.]{0,40}\b(cta|call[- ]to[- ]action|button)\b/i,
      present:
        /\b(visible|shows?|has|includes?|features?|with|contains?)\b[^.]{0,60}\b(cta|call[- ]to[- ]action|button)\b/i,
      label: "headline says CTA missing but a note describes a CTA",
    },
  ];

  for (const c of contradictions) {
    if (headlineSaysMissing(c.missing) && noteSaysPresent(c.present)) {
      const trimmed = trySplitHeadline(headline);
      if (trimmed && !c.missing.test(trimmed)) {
        console.warn(
          `[noteFilter] HEADLINE trim (cross-check) dim="${dim}" reason="${c.label}" url="${ctx.url}" before="${headline}" after="${trimmed}"`,
        );
        return trimmed;
      }
      console.warn(
        `[noteFilter] HEADLINE blank (cross-check) dim="${dim}" reason="${c.label}" url="${ctx.url}" original="${headline}"`,
      );
      return "";
    }
  }

  return headline;
}

/** Try to trim a hallucination clause from the headline by splitting on
 *  common conjunctions ("but", "however", "though", "yet"). Returns the
 *  cleaned first half, or null if no valid split is found. */
function trySplitHeadline(headline: string): string | null {
  const SEPS = [
    /,\s+but\s+/i,
    /\s+but\s+/i,
    /;\s+however[, ]+/i,
    /,\s+however[, ]+/i,
    /;\s+though\s+/i,
    /,\s+though\s+/i,
    /;\s+yet\s+/i,
    /,\s+yet\s+/i,
  ];
  for (const re of SEPS) {
    const match = headline.match(re);
    if (!match || match.index == null) continue;
    const left = headline.slice(0, match.index).trim().replace(/[,;:.]\s*$/, "");
    // Need at least a few words on the left for it to be a real headline.
    if (left.split(/\s+/).length >= 3) return left;
  }
  return null;
}

/** Run all filters and return the first reason that fires, or null. */
function firstFilterHit(
  text: string,
  dim: ClaudeDimension | "takeaways",
  ctx: FilterContext,
): string | null {
  for (const rule of ALL_FILTERS) {
    const reason = rule(text, dim, ctx);
    if (reason) return reason;
  }
  return null;
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
