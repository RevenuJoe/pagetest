/**
 * Master GROUND TRUTH object.
 *
 * Goal: every fact we know about the page lives in one typed object,
 * computed once, before any Claude dimension call runs. The same
 * object is then sliced per dimension (only the facts that dim's
 * criteria reference get sent), so each dim sees a focused GT block
 * instead of the monolithic mega-prompt we used to ship.
 *
 * Two layers of facts:
 *
 *   1. HTML / PSI derived (deterministic, computed from the parsed
 *      PageStructure). These are the counts, lists, and flags we've
 *      always had — paragraph counts, FAQ word counts, image formats,
 *      per-form fields, CTA intent classification, etc.
 *
 *   2. Vision derived (computed by a pre-pass Claude call against the
 *      screenshots, before any dim call fires). The pre-pass produces
 *      a small JSON of facts that need to come from pixels rather than
 *      HTML — nav worksheet (logo present, button count, text-link
 *      count), hero pattern, AtF social proof, mid-page CTA layout,
 *      bottom form visible. Populated by `lib/visualGroundTruth.ts`
 *      and folded into this object before dim calls run.
 *
 * Task #86 — this file ships layer (1) as a pure refactor. Output is
 * byte-identical to what `buildPromptText` produced before. The vision
 * pre-pass (layer 2) lands in Task #87 and slots into the optional
 * `vision` field below.
 */

import type {
  PageStructure,
  FormGroup,
  FormFieldSummary,
} from "./fetchPage";

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** CTAs sorted into the two intent buckets the report cares about. */
export interface ClassifiedCtas {
  bookTime: string[];
  immediate: string[];
  other: string[];
}

/** A heading that exceeds the section-heading word cap. */
export interface LongHeading {
  text: string;
  wordCount: number;
}

/** A <select> on the page that could be tested as a tick-box variant. */
export interface ShortDropdown {
  field: FormFieldSummary;
}

/**
 * Vision-derived facts populated by `lib/visualGroundTruth.ts`.
 * Optional on the master object — populated only after the vision
 * pre-pass runs. Until Task #87 lands this is always undefined and
 * the existing prompt rules continue to ask Claude to judge these
 * from the screenshots itself.
 */
export interface VisualGroundTruth {
  nav: {
    logoPresent: boolean;
    buttonCount: number;
    textLinkCount: number;
    buttonLabels: string[];
    textLinkLabels: string[];
  };
  heroPattern:
    | "button-only"
    | "one-field-email"
    | "dropdown-led"
    | "tickbox-led"
    | "multistep"
    | "embedded-form"
    | "unknown";
  heroVisualPresent: boolean;
  heroBulletsPresent: boolean;
  heroBulletLabels: string[];
  socialProofAboveFold: boolean;
  midPageCtasMostlySolo: boolean;
  bottomFormVisible: boolean;
  heroHeadlineVisible: string;
}

/**
 * Everything we know about the page, in a typed bag. The string
 * formatter for the GT block reads from this object; nothing else
 * needs to touch the raw `PageStructure` outside the build step.
 */
export interface MasterGroundTruth {
  // Identity
  url: string;
  title: string | null;
  metaDescription: string | null;

  // Pull-through (so formatters never have to dig into structure)
  structure: PageStructure;

  // Derived HTML facts (computed once in computeMasterGroundTruth)
  ctaBuckets: ClassifiedCtas;
  longHeadings: LongHeading[];
  shortDropdowns: ShortDropdown[];

  // Vision pre-pass output (Task #87)
  vision?: VisualGroundTruth;
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** Section headings above this word count are flagged in digestibility. */
export const HEADING_WORD_CAP = 10;

/** Max form fields to enumerate in the flat field list. */
const FORM_FIELD_LIST_LIMIT = 25;

/** Max long headings to quote in the prompt. */
const LONG_HEADINGS_LIMIT = 12;

/** Max short dropdowns to enumerate. */
const SHORT_DROPDOWNS_LIMIT = 6;

/** Dedupe + cap helper for CTA label lists. */
function dedupe(arr: string[], cap = 12): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()))).slice(0, cap);
}

// ---------------------------------------------------------------------------
// CTA CLASSIFICATION
// ---------------------------------------------------------------------------

/** "Book a Demo" / "Schedule a Call" / "Talk to Sales" style CTAs. */
const BOOK_TIME_RE =
  /\b(book|schedule|set\s*up|reserve|request|talk\s*to|chat\s*with|meet\s*with|speak\s*to|contact)\b[^.]{0,25}\b(demo|call|sales|meeting|consultation|expert|specialist|chat|us|team)\b/i;
const BOOK_TIME_EXACT_RE =
  /^(get\s+a\s+demo|book\s+a\s+demo|book\s+demo|schedule\s+demo|request\s+a\s+demo|see\s+a\s+demo|talk\s+to\s+sales|contact\s+sales|book\s+a\s+meeting)$/i;
/** "Start free trial" / "Sign up" / "View pricing" / "Get a quote" CTAs. */
const IMMEDIATE_RE =
  /\b(start|try|begin|launch|free\s*trial|sign\s*up|create\s*(an?\s*)?account|get\s*started|view\s*pricing|see\s*pricing|check\s*pricing|get\s*pricing|get\s*a\s*quote|get\s*your\s*quote|get\s*quote|build\s*your\s*own|join\s*free|join\s*now|download)\b/i;

function classifyCta(
  label: string,
): "book-time" | "immediate" | "neither" {
  const trimmed = label.trim();
  if (!trimmed) return "neither";
  if (BOOK_TIME_EXACT_RE.test(trimmed) || BOOK_TIME_RE.test(trimmed))
    return "book-time";
  if (IMMEDIATE_RE.test(trimmed)) return "immediate";
  return "neither";
}

function classifyAllCtas(ctaTexts: string[]): ClassifiedCtas {
  const buckets = {
    bookTime: [] as string[],
    immediate: [] as string[],
    other: [] as string[],
  };
  for (const t of ctaTexts) {
    const b = classifyCta(t);
    if (b === "book-time") buckets.bookTime.push(t);
    else if (b === "immediate") buckets.immediate.push(t);
    else buckets.other.push(t);
  }
  return {
    bookTime: dedupe(buckets.bookTime),
    immediate: dedupe(buckets.immediate),
    other: dedupe(buckets.other),
  };
}

// ---------------------------------------------------------------------------
// HEADING + DROPDOWN DERIVATIONS
// ---------------------------------------------------------------------------

function computeLongHeadings(headings: string[]): LongHeading[] {
  return headings
    .map((text) => ({
      text,
      wordCount: text.trim().split(/\s+/).filter(Boolean).length,
    }))
    .filter((h) => h.wordCount > HEADING_WORD_CAP);
}

function computeShortDropdowns(fields: FormFieldSummary[]): ShortDropdown[] {
  return fields
    .filter(
      (f) =>
        f.tag === "select" &&
        typeof f.optionCount === "number" &&
        f.optionCount !== null &&
        f.optionCount >= 2,
    )
    .map((field) => ({ field }));
}

// ---------------------------------------------------------------------------
// BUILD MASTER OBJECT
// ---------------------------------------------------------------------------

export interface MasterGroundTruthInput {
  url: string;
  title: string | null;
  metaDescription: string | null;
  structure: PageStructure;
}

/**
 * Pure function. Compute every derived fact we need for the GT block
 * in one place, return the typed bag. Idempotent and side-effect-free
 * so it's safe to call once at the top of an analyse request and pass
 * the result around.
 */
export function computeMasterGroundTruth(
  input: MasterGroundTruthInput,
): MasterGroundTruth {
  return {
    url: input.url,
    title: input.title,
    metaDescription: input.metaDescription,
    structure: input.structure,
    ctaBuckets: classifyAllCtas(input.structure.ctaTexts),
    longHeadings: computeLongHeadings(input.structure.headings),
    shortDropdowns: computeShortDropdowns(input.structure.formFields),
  };
}

/** Attach vision-pre-pass output to an existing master object. */
export function attachVisualGroundTruth(
  master: MasterGroundTruth,
  vision: VisualGroundTruth,
): MasterGroundTruth {
  return { ...master, vision };
}

// ---------------------------------------------------------------------------
// STRING FORMATTER (full block, same output as the old buildPromptText)
// ---------------------------------------------------------------------------

function formatFormField(f: FormFieldSummary): string {
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
}

function formatFormFieldsBlock(fields: FormFieldSummary[]): string {
  if (fields.length === 0) {
    return "  (no form fields parsed from the HTML)";
  }
  const lines = fields.slice(0, FORM_FIELD_LIST_LIMIT).map(formatFormField);
  const overflow =
    fields.length > FORM_FIELD_LIST_LIMIT
      ? `\n  ...and ${fields.length - FORM_FIELD_LIST_LIMIT} more`
      : "";
  return lines.join("\n") + overflow;
}

function formatShortDropdownsBlock(drops: ShortDropdown[]): string {
  return drops
    .slice(0, SHORT_DROPDOWNS_LIMIT)
    .map(({ field: f }) => {
      const id = f.name ?? f.id ?? "(unnamed)";
      const labels =
        f.optionLabels && f.optionLabels.length > 0
          ? ` — options: ${f.optionLabels
              .map((l) => `"${l}"`)
              .join(", ")}`
          : "";
      return `  - <select> ${id} — ${f.optionCount} options${labels}`;
    })
    .join("\n");
}

function formatLongHeadingsBlock(longHeadings: LongHeading[]): string {
  return longHeadings
    .slice(0, LONG_HEADINGS_LIMIT)
    .map((h) => `    • ${h.wordCount} words: "${h.text}"`)
    .join("\n");
}

/**
 * Render the VISION GROUND TRUTH section. When the vision pre-pass
 * succeeded, this is a block of authoritative pixel-derived facts
 * that the dim calls treat as the final word on nav layout, hero
 * pattern, AtF social proof, mid-page CTA layout and bottom-form
 * presence. When the pre-pass failed (returned null), we still emit
 * a short note so the dim prompts know they have to fall back to
 * judging from the screenshot themselves.
 */
function formatVisualGroundTruthSection(
  vision: VisualGroundTruth | undefined,
): string {
  if (!vision) {
    return [
      "VISION GROUND TRUTH — not available for this run (vision pre-pass did not produce a result).",
      "When vision facts are unavailable, fall back to judging nav layout, hero pattern, above-fold social proof, mid-page CTA layout and bottom-form presence from the attached screenshots directly. Be conservative: state what you can clearly see, and don't invent details the screenshot doesn't show.",
      "",
    ].join("\n");
  }
  const { nav } = vision;
  const navButtonLabels =
    nav.buttonLabels.length > 0
      ? nav.buttonLabels.map((l) => `"${l}"`).join(", ")
      : "(none)";
  const navTextLinkLabels =
    nav.textLinkLabels.length > 0
      ? nav.textLinkLabels.map((l) => `"${l}"`).join(", ")
      : "(none)";
  const heroBullets =
    vision.heroBulletLabels.length > 0
      ? vision.heroBulletLabels.map((l) => `"${l}"`).join(", ")
      : "(none captured)";
  return [
    "VISION GROUND TRUTH — facts extracted from the page screenshots by a dedicated vision pre-pass. Treat these as AUTHORITATIVE for nav layout, hero pattern, above-fold social proof, mid-page CTA layout and bottom-form presence. If you find yourself wanting to write a different value, you are wrong and the pre-pass is right — work from these numbers and verdicts.",
    "",
    "- Nav worksheet (extracted from the above-the-fold screenshot):",
    `    • Logo present on the left: ${nav.logoPresent ? "YES" : "NO"}`,
    `    • Number of buttons in the nav: ${nav.buttonCount}  (labels: ${navButtonLabels})`,
    `    • Number of text links in the nav (NOT buttons, NOT the logo): ${nav.textLinkCount}  (labels: ${navTextLinkLabels})`,
    "  Use these three numbers verbatim in any AtF nav note. Do NOT re-count from the screenshot, and do NOT cite the HTML <nav> link list (it includes dropdown sub-items and CSS-hidden links that aren't rendered in the hero).",
    "",
    `- Hero pattern (primary conversion control in the hero): ${vision.heroPattern}`,
    "  Meaning of each pattern, for reference:",
    "    button-only      — only a CTA button (or two), no form fields visible.",
    "    one-field-email  — a single email input next to a submit button.",
    "    dropdown-led     — the hero leads with a <select> dropdown plus a submit.",
    "    tickbox-led      — visible tick boxes / radio buttons / chip-style options.",
    "    multistep        — a multi-step form / quiz with Next / Continue buttons.",
    "    embedded-form    — a full lead-gen form with multiple labelled inputs.",
    "    unknown          — pre-pass could not determine the pattern.",
    "  Use this verdict directly. AtF / CRO bonus eligibility depends on this single field.",
    "",
    `- Strong hero visual present (product shot, illustration, photograph, looping video): ${vision.heroVisualPresent ? "YES" : "NO"}`,
    `- Hero bullets / feature pills present: ${vision.heroBulletsPresent ? "YES" : "NO"}  (captured: ${heroBullets})`,
    "",
    `- Above-the-fold social proof (visible inside the AtF viewport): ${vision.socialProofAboveFold ? "YES" : "NO"}`,
    "  This is the pixel-level truth. Do NOT contradict it. If YES, do NOT say social proof is missing from the hero or recommend moving it into the hero. If NO and the HTML scan says the page has social proof elsewhere, you may suggest surfacing it higher, phrased carefully.",
    "",
    `- Mid-page CTAs mostly solo (the buttons between the hero and footer, after content sections): ${vision.midPageCtasMostlySolo ? "YES" : "NO"}`,
    "  When YES, the CRO secondary-CTA pairing recommendation applies. When NO, mid-page CTAs are already paired and that recommendation does NOT belong in the report.",
    "",
    `- Bottom form visible above the footer in the full-page screenshot: ${vision.bottomFormVisible ? "YES" : "NO"}`,
    "  If YES, the page HAS a bottom lead-gen form (even if it's just a one-field email input). Do NOT recommend adding one. The TOP + BOTTOM CONVERSION COMBO bonus applies when this AND the hero has a conversion control.",
    "",
    `- Hero headline (exact text visible at the top of the AtF screenshot): ${vision.heroHeadlineVisible ? `"${vision.heroHeadlineVisible}"` : "(pre-pass could not read it cleanly)"}`,
    "  When you quote the hero headline in a note, use this string verbatim. Do NOT use the first <h1> from the HTML list below as a shortcut — on CSS-reordered pages those don't match.",
    "",
  ].join("\n");
}

function formatPerFormBlock(forms: FormGroup[]): string {
  return forms
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
                if (field.placeholder)
                  parts.push(`placeholder="${field.placeholder}"`);
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
      return `  - Form #${f.index + 1} — ${positionLabel}, ${f.fields.length} field${
        f.fields.length === 1 ? "" : "s"
      }${cta}:\n${fieldSummary}`;
    })
    .join("\n");
}

/**
 * Produce the full GROUND TRUTH + structural summary + body text
 * string the Claude dim/critic/takeaways calls received before
 * Task #86. Byte-identical output to the old `buildPromptText`.
 *
 * `bodyTextCharLimit` controls the body excerpt size — 15k for the
 * AtF / Mobile dim calls (hero only), 60k for everything else.
 */
export function formatGroundTruthFull(
  master: MasterGroundTruth,
  bodyText: string,
  bodyTextCharLimit: number,
): string {
  const s = master.structure;
  const formFieldsBlock = formatFormFieldsBlock(s.formFields);
  const formsBlock = formatPerFormBlock(s.forms);
  const shortDropdownsBlock = formatShortDropdownsBlock(master.shortDropdowns);
  const longHeadingsBlock = formatLongHeadingsBlock(master.longHeadings);
  const { bookTime: bookTimeUnique, immediate: immediateUnique, other: otherUnique } =
    master.ctaBuckets;
  const visionBlock = formatVisualGroundTruthSection(master.vision);

  return [
    `URL: ${master.url}`,
    `Title: ${master.title ?? "(none)"}`,
    `Meta description: ${master.metaDescription ?? "(none)"}`,
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
    visionBlock,
    "GROUND TRUTH (HTML LAYER) — facts parsed directly from the page HTML. Treat these as authoritative. Do NOT contradict them. Do NOT claim the page has elements that aren't listed here, and do NOT recommend adding elements that ARE listed here. Where the VISION GROUND TRUTH above and the HTML layer below disagree (e.g. HTML nav link counts vs the vision nav worksheet), the VISION layer wins because the screenshot is the live rendered page.",
    "",
    `- Form contains a phone-number field: ${s.hasPhoneField ? "YES" : "NO"}`,
    `- Form contains an email field: ${s.hasEmailField ? "YES" : "NO"}`,
    `- Total fillable form fields on the page: ${s.formFields.length}`,
    `- Total <form> elements on the page: ${s.formCount}`,
    "- Form fields on the page (tag + attributes, flat list across all forms):",
    formFieldsBlock,
    "",
    `- <form> elements detected on the page, in document order: ${s.forms.length}`,
    s.forms.length > 0
      ? formsBlock
      : "  (no <form> tags found — fields may be wrapped in <div> with JS handlers; defer to the screenshot to identify forms)",
    "- IMPORTANT — anti-hallucination rule for forms:",
    "    When describing what fields a SPECIFIC form has (hero form, bottom form, footer form, etc.), the fields you name MUST appear in the per-<form> breakdown above for that form's position. Do NOT invent fields like 'first name', 'last name', 'company name', 'phone' if those fields aren't listed for the form you're describing. If the bottom form has 1 email input, say 'a one-field email form', not 'a full lead-gen form with first name, last name, company, and email'. If the page has zero <form> tags but you can clearly see a form in the screenshot, describe it from the screenshot but flag that the HTML couldn't confirm it.",
    "- IMPORTANT — bottom-form check (MANDATORY before any 'no bottom form' / 'bottom form is missing' / 'add a bottom lead-gen form' recommendation):",
    "    Before writing ANY claim that the page has no bottom form, you MUST check BOTH:",
    "      (1) The per-<form> breakdown above. Look for forms at 'late' position (likely bottom / footer area) AND 'middle' position. A 'late' form is a bottom form even if it only has one field (one-field email forms count!). A 'middle' form near the end of the candidate list also counts.",
    "      (2) The FULL-PAGE SCREENSHOT. Scroll your visual attention to the bottom of the page above the footer. If you can see any form input there — even a single email field next to a 'Get a Demo' / 'Start Free' button — that IS a bottom form.",
    "    If EITHER check confirms a bottom form exists, do NOT say it's missing. Describe what's there instead (e.g. 'the page has a one-field email form above the footer'). Only claim 'no bottom form' when BOTH the per-<form> list is empty of late/middle forms AND the screenshot shows no form near the footer.",
    "    A one-field email form at the bottom IS a bottom lead-gen form for CRO scoring purposes — it qualifies the page for the TOP + BOTTOM CONVERSION COMBO bonus. Don't dismiss it because it's small.",
    "",
    `- Hero-form dropdown candidates for tick-box conversion (any <select> with 2+ options): ${master.shortDropdowns.length}`,
    master.shortDropdowns.length > 0 ? shortDropdownsBlock : "  (none)",
    "- NOTE: any recommendation about converting a hero-form dropdown into visible TICK BOXES belongs in the CRO dimension only, NOT in Above-the-fold. The CRO criteria document explains when this applies.",
    "  Always use the phrase 'tick boxes' for this conversion. Do NOT say 'radio buttons', 'radio-button group', 'chips', or 'pills'.",
    "  Always phrase the recommendation as 'display 4 or fewer tick boxes' — this is the IMPLEMENTATION cap, independent of how many options the source dropdown has. If the dropdown has 3 options, recommend 3 tick boxes. If it has 8 options, recommend 4 tick boxes showing the most useful choices (or restructuring the question to reduce the option set to 4). Never recommend more than 4 tick boxes in the hero form, no matter how many options the source dropdown has.",
    "  ALWAYS frame the recommendation as an A/B TEST, never as a definitive change. Use openings like 'Test converting…', 'A/B test the…', 'Run an A/B test of…' — do NOT lead with 'Convert the…', 'Replace the…', 'Change the…'. The variant might not win; the recommendation is to RUN A TEST and measure the conversion delta. This applies whether the recommendation lives in a dimension note, a headline, or a key recommendation.",
    "",
    "- Navigation: nav commentary is OFF-LIMITS in every dimension EXCEPT Above-the-fold. Content / Digestibility / CRO / Mobile must NOT count nav links, describe whether the nav is lean / bulky, list nav labels, or recommend adding / removing nav items.",
    "- Navigation worksheet (AtF dim only — fill these in by looking at the ABOVE-THE-FOLD SCREENSHOT before writing any nav commentary). NO HTML nav data is provided here on purpose — the HTML <nav> / <header> counts include dropdown sub-menu items, mobile-menu duplicates, and CSS-hidden links that aren't rendered in the desktop hero. The screenshot is the SOLE authority.",
    "    • Logo present on the left: YES / NO  (count this from the AtF screenshot)",
    "    • Number of buttons in the nav: N  (count visibly button-styled elements — coloured background, clearly clickable. 'Book a Call', 'Get a Demo', 'Start Free Trial', 'Sign Up'. Do NOT count plain text links as buttons.)",
    "    • Number of text links in the nav (NOT buttons, NOT the logo): N  (count plain text items like 'Pricing', 'Resources', 'About', 'Products'.)",
    "  These three counts are the FOUNDATION of any nav observation. State them in your AtF nav note before forming a verdict. See CRITERIA_ABOVE_THE_FOLD for the best-practice criteria.",
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
      ? `- Image alt text (verbatim, up to 20 shown): ${s.imageAlts
          .slice(0, 20)
          .map((a) => `"${a}"`)
          .join(", ")}`
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
      ? `- CTA labels (verbatim, up to 20 shown): ${s.ctaTexts
          .slice(0, 20)
          .map((t) => `"${t}"`)
          .join(", ")}`
      : "- CTA labels: (none)",
    "",
    "- CTA intent classification (the page is split into two buckets that serve different user intents):",
    `    Book-time CTAs (high-commitment, e.g. 'Get a Demo' / 'Book a Demo' / 'Talk to Sales'): ${bookTimeUnique.length} unique label${bookTimeUnique.length === 1 ? "" : "s"}`,
    bookTimeUnique.length > 0
      ? `      labels: ${bookTimeUnique.map((t) => `"${t}"`).join(", ")}`
      : "      (none — no book-a-time CTAs detected)",
    `    Immediate-action CTAs (low-commitment do-it-now, e.g. 'Start free trial' / 'View pricing' / 'Get a quote' / 'Sign up'): ${immediateUnique.length} unique label${immediateUnique.length === 1 ? "" : "s"}`,
    immediateUnique.length > 0
      ? `      labels: ${immediateUnique.map((t) => `"${t}"`).join(", ")}`
      : "      (none — no immediate-action CTAs detected)",
    `    Other CTAs (don't fit either bucket cleanly): ${otherUnique.length} unique label${otherUnique.length === 1 ? "" : "s"}`,
    otherUnique.length > 0
      ? `      labels (up to 12 shown): ${otherUnique.map((t) => `"${t}"`).join(", ")}`
      : "      (none)",
    "- IMPORTANT — SECONDARY-CTA PAIRING RULE (CRO, mid-page focus):",
    "    Ideal landing pages pair ONE book-time CTA with ONE immediate-action CTA side by side so the visitor can pick whichever matches their intent. Two CTAs work HARDER than one — they don't compete, they capture different segments.",
    "    SCOPE: This recommendation is specifically about MID-PAGE CTAs — the buttons sitting after content sections (feature blocks, stats blocks, FAQ section, role-tabs, etc.) BETWEEN the hero and the footer. Do NOT apply it to:",
    "      • the navigation / header CTA (usually a single 'Get a Demo' top-right — that's the expected pattern, don't recommend a second one there);",
    "      • the hero / above-the-fold CTA (often paired with a form or qualifying widget — different criterion applies, see the hero-form patterns above);",
    "      • CTAs inside a form (Submit / Next / Continue buttons aren't standalone CTAs).",
    "    HOW TO JUDGE THIS — rely MAINLY on the FULL-PAGE SCREENSHOT, not the HTML CTA list above. The HTML count tells you how many CTAs exist and what labels they use, but it CANNOT tell you whether they're rendered SOLO (one button alone at the end of a section) or PAIRED (two buttons side by side). Only the screenshot shows visual layout, so the screenshot is the authority for this rule. Use the HTML CTA labels above as a HINT for what intents the page currently covers, then look at the full-page screenshot to identify which mid-page CTAs are solo and which are already paired.",
    "    If most of the mid-page CTAs appear solo in the screenshot, AND the page's CTA set leans heavily on one intent bucket (only book-time CTAs, or only immediate-action), recommend TESTING a SECONDARY CTA alongside the mid-page primary. Good secondary CTAs to suggest:",
    "      • If the page already has 'Get a Demo' / 'Book a Demo' style CTAs → suggest pairing with an immediate-action CTA: 'Start free trial', 'View pricing', 'Get a quote', or 'Sign up'.",
    "      • If the page only has immediate-action CTAs → suggest pairing with a book-time CTA: 'Book a demo' or 'Talk to sales'.",
    "    Phrase the recommendation as a TEST (not a definitive change). Make it PROMINENT when many of the MID-PAGE CTAs are solo — this is one of the highest-impact tweaks a marketing page can make.",
    "",
    `- Total headings (H1/H2/H3) on the page: ${s.headings.length}`,
    `- Total <h1> elements on the page: ${s.h1Texts.length}`,
    s.h1Texts.length > 0
      ? `- All <h1> elements in HTML SOURCE order (NOT necessarily visual order — see rule below):\n${s.h1Texts.map((t, i) => `    ${i + 1}. "${t}"`).join("\n")}`
      : "- All <h1> elements: (none)",
    "- IMPORTANT — HERO HEADLINE RULE:",
    "    The H1 list above is in HTML SOURCE order, NOT visual page order. On pages where CSS reorders sections (very common on modern landing-page builders, Webflow, Framer, etc.), the FIRST <h1> in the source can actually render at the BOTTOM of the page, and a later <h1> can be the visual hero. The hero headline is whichever heading you can see at the TOP of the above-the-fold screenshot.",
    "    When you quote the hero headline in a note, the quoted text MUST exactly match what is visible at the top of the AtF screenshot. Do NOT use the first <h1> from the list above as a shortcut — verify visually first. If the screenshot is ambiguous, do NOT quote a specific hero headline at all; describe the hero without quoting.",
    "    Worked failure mode you must avoid: a page has 10 <h1>s. The FIRST in source order is the bottom-of-page CTA section's heading. The visual hero is the 4th <h1> in source order, which is what the AtF screenshot shows at the top. Quoting the 1st <h1> as the hero headline is WRONG. Always read the hero headline from the screenshot.",
    "",
    `- Section headings (H1/H2/H3) longer than ${HEADING_WORD_CAP} words, parsed from HTML: ${master.longHeadings.length} out of ${s.headings.length} total`,
    master.longHeadings.length > 0
      ? longHeadingsBlock
      : "    (none — every heading parsed from the HTML is within the 10-word best practice)",
    "- IMPORTANT — SECTION-HEADING LENGTH RULE (digestibility):",
    "    Best practice is section headings of 10 WORDS OR FEWER. Anything longer scans badly — readers can't grasp the section's point at a glance.",
    "    The count above is parsed from HTML <h1>/<h2>/<h3> tags. THE FULL-PAGE SCREENSHOT IS THE AUTHORITY. Many pages style <div> elements to look like section headings (or label real headings with the wrong level), so HTML tag count can be misleading. Cross-reference: look at the full-page screenshot and confirm each long heading from the list actually renders as a visible section heading. Conversely, if the screenshot shows visible section headings that AREN'T in this list (because they're styled <div>s), count those too and add them to your assessment.",
    "    When reporting in the digestibility notes, say HOW MANY section headings exceed 10 words and quote 1-2 of the longest as examples (e.g. '4 section headings run longer than 10 words; the worst at 17 words is \"...\"'). Do NOT vaguely say 'some headlines are long' — give the count.",
    "",
    `- Paragraphs (<p> elements outside FAQ blocks): ${s.paragraphWordCounts.length} total, ${s.longParagraphs.length} exceed 50 words`,
    s.longParagraphs.length > 0
      ? s.longParagraphs
          .slice(0, 8)
          .map((p) => `    • ${p.wordCount} words: "${p.snippet}…"`)
          .join("\n")
      : "    (none — every paragraph is within the 50-word digestibility best practice)",
    "- IMPORTANT — PARAGRAPH-LENGTH RULE (digestibility):",
    "    All paragraphs OUTSIDE OF THE FAQ SECTION should average 50 words or fewer. FAQ answers have their own 75-word cap (see the FAQ block below) and are judged SEPARATELY — do NOT add FAQ answers to the paragraph count. When reporting in the digestibility notes, you MUST use the exact phrase 'paragraphs outside of the FAQ section' so the reader knows the FAQ is excluded. Quote the exact count from the GROUND TRUTH line above (e.g. '4 of 12 paragraphs outside of the FAQ section exceed 50 words') and quote 1-2 of the longest as examples with their word counts. Do NOT vague-wave with 'some paragraphs run long' — give the count.",
    "    The full-page screenshot is helpful for verifying which long-paragraph blocks visually feel like walls of text on the page. If the screenshot shows a section that LOOKS like a wall of text but doesn't appear in the long-paragraph list (e.g. it's a styled <div> not a <p>), count it too.",
    "",
    `- FAQ-style Q/A pairs detected on the page (via <details>/<summary> or faq-class patterns): ${s.faqAnswers.length}`,
    s.faqAnswers.length > 0
      ? s.faqAnswers
          .slice(0, 12)
          .map((f) => {
            const tooLong = f.answerWordCount > 75 ? "  ← OVER 75 words" : "";
            return `    • Q: "${f.question}" — answer is ${f.answerWordCount} words${tooLong}`;
          })
          .join("\n")
      : "    (none — page either has no FAQ section, the FAQ is rendered client-side, or it uses a markup pattern we don't detect)",
    "- IMPORTANT — FAQ-ANSWER LENGTH RULE (digestibility):",
    "    Best practice is 75 words or fewer per FAQ answer. Any answer marked '← OVER 75 words' above is too long and HURTS digestibility — readers can't skim past it. When a page's FAQs include answers above 75 words, the digestibility verdict should reflect that. Do NOT write generic praise like 'the FAQ uses tight Q&A pairs with short answers' if ANY answer in the list above is over 75 words — that contradicts the data. If you call out the FAQ length, quote the actual word count from this list (e.g. 'the combinatorial-optimisation answer runs 128 words') so the recommendation is concrete.",
    "    When NO FAQ pairs were detected (count: 0) it does NOT prove the page has no FAQ — it may be client-rendered. In that case fall back to the body text and the screenshots before commenting on FAQ length.",
    "",
    bodyTextCharLimit >= 60_000
      ? "Body text of the FULL page (top to bottom, may be lightly truncated):"
      : `Body text of the page (first ~${Math.round(bodyTextCharLimit / 1000)},000 chars — the visible above-the-fold + nearby content):`,
    "---",
    bodyText.slice(0, bodyTextCharLimit),
    "---",
    "",
    "Use the body text AND the attached screenshots together to verify everything. Bottom-of-page forms, FAQ sections, social-proof logo strips, footer CTAs all count.",
  ].join("\n");
}
