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
const filterAnyNavCommentary: FilterRule = (note, dim) => {
  // Above-the-fold is the ONE dimension allowed to comment on the nav
  // (judged from the AtF screenshot). All other dimensions still treat
  // nav as off-limits because nav-link detection from raw HTML is
  // unreliable and we don't want nav opinions creeping into Content /
  // Digestibility / CRO / Mobile notes.
  if (dim === "aboveTheFold") return null;
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
const filterNavMissingButHasContent: FilterRule = (note, dim, ctx) => {
  // Above-the-fold gets to comment on nav from the screenshot — skip
  // this HTML-vs-claim contradiction filter for that dim.
  if (dim === "aboveTheFold") return null;
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
const filterNavBulky: FilterRule = (note, dim, ctx) => {
  // Above-the-fold judges nav from the screenshot, where "bulky" is
  // an actual visual call. Skip the HTML-link-count contradiction
  // check for AtF and let the dim use its own criteria.
  if (dim === "aboveTheFold") return null;
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

/** Recommending a bottom / final / footer form when the page has 2+
 *  forms (so one is almost certainly the bottom one). */
/**
 * "Social proof appears below the fold" / "move logos into the hero"
 * style claims. These contradict the AtF screenshot whenever the page
 * has any trust markers visible at the bottom of the hero (a logo
 * strip cropped at the edge is the worst offender — Claude reads the
 * HTML-position heuristic as authoritative and says move-it, even
 * though the screenshot clearly shows the logos in the AtF viewport).
 *
 * We fire this filter when:
 *   - the note matches one of the "below the fold" / "move ... above
 *     the fold" / "move into hero" patterns about social proof, AND
 *   - GROUND TRUTH says the page DOES have social proof (so it's not
 *     a legitimate "page is missing social proof entirely" note).
 *
 * The risk is that on a page where social proof is GENUINELY below
 * the fold (and visually absent from the AtF screenshot), we'd drop
 * a legitimate "move it up" note. We accept that trade-off because
 * the contradicting-screenshot hallucination is much more harmful
 * than missing one valid placement note.
 */
const filterSocialProofBelowFoldClaim: FilterRule = (note, _dim, ctx) => {
  if (!ctx.structure.socialProofPresent) return null;
  const matchesBelowFoldClaim =
    /\bsocial\s+proof\b[^.]{0,80}\b(appears?|is)\b[^.]{0,40}\bbelow\s+the\s+fold\b/i.test(note) ||
    /\b(trust\s+(line|signals|markers)|customer\s+logos|logos|logo\s+strip)\b[^.]{0,80}\b(appears?|is|are|sit|sits|live|lives)\b[^.]{0,40}\bbelow\s+the\s+fold\b/i.test(note) ||
    /\bmov(e|ing)\b[^.]{0,80}\b(trust\s+(line|signals|markers)|social\s+proof|customer\s+logos|logo\s+strip|logos|hospital\s+(logos|names)|named\s+customers?)\b[^.]{0,80}\b(into|to|above)\b[^.]{0,40}\b(hero|above\s+the\s+fold)\b/i.test(note) ||
    /\b(promote|surface|hoist|pull|bring)\b[^.]{0,80}\b(trust\s+(line|signals|markers)|social\s+proof|customer\s+logos|logo\s+strip|logos)\b[^.]{0,80}\b(into|above)\b[^.]{0,40}\b(hero|above\s+the\s+fold|fold)\b/i.test(note);
  if (!matchesBelowFoldClaim) return null;
  return "social-proof location claim contradicts screenshot — page has social proof on it (GROUND TRUTH) and the AtF screenshot is authoritative for fold position";
};

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

/**
 * "Two competing forms" / "multiple competing forms" / "hero form
 * competes with supporting content" / "hero contains two forms" — a
 * common hallucination where Claude mistakes a multi-step form's
 * sequential steps for two separate forms, or mistakes an unrelated
 * <form>-tagged account button for a competing conversion form.
 *
 * Our criteria don't say multiple forms are a problem — the opposite,
 * they say the hero form + bottom form (the ideal pattern) are
 * deliberately different. So any note framing "competing forms" as a
 * negative is a fabrication.
 */
const filterCompetingForms: FilterRule = (note) => {
  const said =
    /\b(two|multiple|competing|duplicate)\s+(competing\s+)?forms\b/i.test(note) ||
    /\bforms?\s+(?:are\s+)?competing\b/i.test(note) ||
    /\bforms?\s+competes?\s+with\b/i.test(note) ||
    /\bhero\s+(?:has|contains|includes)\s+(?:two|multiple)\s+[^.]{0,30}\bforms?\b/i.test(note) ||
    /\bforms?\s+side[- ]by[- ]side\b/i.test(note) ||
    /\b(remove|collapse|consolidate)\s+one\s+of\s+the\s+(?:two\s+)?forms?\b/i.test(note) ||
    /\bdivides?\s+attention\b[^.]{0,80}\bforms?\b/i.test(note);
  if (!said) return null;
  return "competing-forms claim (multi-step form is ONE form; account-button <form> isn't a competing conversion form)";
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
  filterSocialProofBelowFoldClaim,
  filterAddBottomForm,
  filterSignInRecommendation,
  filterPhoneFieldGhost,
  filterBottomFormShouldRepeat,
  filterCompetingForms,
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

// ---------------------------------------------------------------------------
// CONTRADICTION SWEEP
// ---------------------------------------------------------------------------

/**
 * Final contradiction check applied after the critic pass. For each
 * "add X" takeaway / note, scans every other note + headline in the
 * report for a positive statement about X (e.g. "shows X", "has X",
 * "X is present"). If found, the recommendation is dropped because
 * recommending we add something the page already has is the most
 * common style of hallucination and the most jarring for the reader.
 *
 * Deterministic. No model involvement. Topic list is curated to the
 * concrete recommendations we keep seeing contradicted.
 */

interface ContradictionTopic {
  key: string;
  /** Matches the topic word(s) anywhere in a note. */
  topic: RegExp;
  /** Label used in the drop-reason log. */
  label: string;
}

const CONTRADICTION_TOPICS: ContradictionTopic[] = [
  {
    key: "social_proof",
    topic: /\b(social\s+proof|customer\s+logos?|trust\s+signals?|testimonials?|customer\s+ratings?|brand\s+logos?)\b/i,
    label: "social proof / customer logos",
  },
  {
    key: "faq",
    topic: /\b(faqs?|frequently\s+asked\s+questions?)\b/i,
    label: "FAQ section",
  },
  {
    key: "comparison",
    topic: /\b(comparison\s+(?:table|section|framing)?|compare\s+to|vs\.?\s+the\s+(?:competitor|old\s+way|alternative)|competitor\s+table|you\s+vs\.?)\b/i,
    label: "comparison framing",
  },
  {
    key: "bottom_form",
    topic: /\b(bottom\s+(?:form|cta)|final\s+(?:form|cta)|footer\s+form|closing\s+(?:form|cta))\b/i,
    label: "bottom / final form or CTA",
  },
  {
    key: "problem_statement",
    topic: /\b(problem\s+(?:statement|framing|narrative|definition)|name(?:s|d)?\s+the\s+(?:pain|problem))\b/i,
    label: "problem statement",
  },
  {
    key: "hero_cta",
    topic: /\bhero\s+(?:cta|button|widget|conversion)\b/i,
    label: "hero CTA / widget",
  },
  {
    key: "pricing",
    topic: /\b(pricing\s+(?:section|page|tiers?|plans?|table)|price\s+points?)\b/i,
    label: "pricing section",
  },
  {
    key: "case_studies",
    topic: /\bcase\s+stud(?:ies|y)\b/i,
    label: "case studies",
  },
  {
    key: "stats",
    topic: /\bstats?\s+(?:section|block|panel)|concrete\s+numbers?\b/i,
    label: "stats / concrete numbers",
  },
  {
    key: "value_prop",
    topic: /\bvalue\s+prop(?:osition)?|benefit[- ]led\s+(?:headline|copy)/i,
    label: "value proposition / benefit-led copy",
  },
];

/** Action verbs that indicate a recommendation to ADD something. */
const ACTION_VERB = /\b(add|introduce|include|insert|build|create|missing|lack(?:s|ing)?|needs?|require[sd]?|should\s+have|consider\s+adding)\b/i;

/** Verbs / phrasings that indicate the thing is ALREADY PRESENT. */
const PRESENT_VERB = /\b(has|have|shows?|displays?|delivers?|provides?|includes?|features?|contains?|with|visible|present|appears?|already\s+(?:has|includes|shows))\b/i;

/** Run the contradiction sweep over every note + every headline in
 *  every dimension AND every takeaway. Returns cleaned versions.
 *  Accepts an optional ground-truth context to enforce structural
 *  flags like `socialProofPresent` as authoritative. */
export function runContradictionSweep(
  dimensions: Record<string, CheckResult>,
  takeaways: KeyTakeaway[],
  url: string,
  groundTruth?: { socialProofPresent?: boolean },
): { dimensions: Record<string, CheckResult>; takeaways: KeyTakeaway[] } {
  // Build the pool of positive statements: every note + headline that
  // says some topic is present. We'll check "add X" recommendations
  // against this pool.
  const positiveTexts: string[] = [];
  for (const dim of Object.keys(dimensions)) {
    const r = dimensions[dim];
    if (r?.headline) positiveTexts.push(r.headline);
    for (const n of r?.notes ?? []) positiveTexts.push(n);
  }

  function isPositiveAbout(topic: RegExp, text: string): boolean {
    if (!topic.test(text)) return false;
    if (!PRESENT_VERB.test(text)) return false;
    // Exclude obviously-negative phrasings: "no X visible", "missing X".
    if (/\b(no|without|missing|lacks?|lacking|absent)\b[^.]{0,40}/i.test(text)) {
      // Make sure the negative isn't about a DIFFERENT thing in the
      // same sentence. We test that the topic match isn't immediately
      // preceded by a negation.
      const m = text.match(topic);
      if (m && m.index != null) {
        const pre = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
        if (/\b(no|without|missing|lacks?|lacking|absent)\b[^.]{0,40}$/.test(pre)) {
          return false;
        }
      }
    }
    return true;
  }

  function isRecommendingAddition(text: string): boolean {
    return ACTION_VERB.test(text);
  }

  /** Check one candidate text against the positive pool. Returns the
   *  topic label that contradicts, or null if no contradiction. */
  function findContradiction(text: string, ownPool: string[]): string | null {
    if (!isRecommendingAddition(text)) return null;
    // GROUND-TRUTH override: socialProofPresent is authoritative. If
    // the page has social proof anywhere and the text recommends
    // adding it, drop immediately without needing a counter-note.
    if (groundTruth?.socialProofPresent) {
      const socialProofTopic = CONTRADICTION_TOPICS.find(
        (t) => t.key === "social_proof",
      );
      if (socialProofTopic?.topic.test(text)) {
        return `${socialProofTopic.label} (GROUND TRUTH: socialProofPresent=YES)`;
      }
    }
    for (const t of CONTRADICTION_TOPICS) {
      if (!t.topic.test(text)) continue;
      // Look for any other text in the pool that says this topic is
      // already present.
      const positive = ownPool.some((pt) => pt !== text && isPositiveAbout(t.topic, pt));
      if (positive) return t.label;
    }
    return null;
  }

  // Filter dimension notes.
  const cleanedDimensions: Record<string, CheckResult> = {};
  for (const dim of Object.keys(dimensions)) {
    const r = dimensions[dim];
    const keptNotes: string[] = [];
    for (const note of r.notes) {
      const contradiction = findContradiction(note, positiveTexts);
      if (contradiction) {
        console.warn(
          `[contradictionSweep] DROP note dim="${dim}" topic="${contradiction}" url="${url}" note="${note}"`,
        );
      } else {
        keptNotes.push(note);
      }
    }
    cleanedDimensions[dim] = { ...r, notes: keptNotes };
  }

  // Filter takeaways. Each takeaway is also checked against the
  // positive pool — if it recommends adding X and a dimension says X
  // is present, drop it.
  const keptTakeaways: KeyTakeaway[] = [];
  for (const tk of takeaways) {
    const text = typeof tk === "string" ? tk : tk.text;
    const contradiction = findContradiction(text, positiveTexts);
    if (contradiction) {
      console.warn(
        `[contradictionSweep] DROP takeaway topic="${contradiction}" url="${url}" text="${text}"`,
      );
    } else {
      keptTakeaways.push(tk);
    }
  }

  return { dimensions: cleanedDimensions, takeaways: keptTakeaways };
}
