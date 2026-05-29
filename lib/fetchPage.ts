/**
 * Lightweight server-side fetch of a URL's HTML.
 *
 * We do this in addition to PageSpeed because PSI doesn't expose the rendered
 * markup directly — and Claude needs the actual page structure (headings,
 * buttons, forms, body copy) to score content / digestibility / CRO.
 *
 * This is a raw HTTP fetch — it does NOT execute JavaScript. For
 * single-page-app sites that render entirely client-side the body text will be
 * thin; in that case Claude can still reason from the screenshots PSI returns.
 */

const MAX_HTML_BYTES = 1_500_000; // ~1.5MB safety cap

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string | null;
  html: string;
  /** Trimmed, mostly-readable body text — scripts/styles removed. */
  bodyText: string;
  title: string | null;
  metaDescription: string | null;
  /** Counts of structural elements that drive the digestibility/CRO checks. */
  structure: PageStructure;
}

export interface PageStructure {
  h1Count: number;
  h2Count: number;
  h3Count: number;
  paragraphCount: number;
  imgCount: number;
  imgMissingAlt: number;
  linkCount: number;
  buttonCount: number;
  formCount: number;
  inputCount: number;
  hasNav: boolean;
  hasFooter: boolean;
  wordCount: number;
  /** Concrete form-field inventory parsed from the raw HTML. Used as ground
   *  truth in the Claude prompt so the model never guesses about field
   *  presence (e.g. phone fields). Each entry describes one input/textarea/
   *  select element with whatever identifying attributes were on it. */
  formFields: FormFieldSummary[];
  /** True when at least one <input> on the page has type="tel" or a name /
   *  id / placeholder containing "phone". A blunt yes/no signal Claude can
   *  rely on without re-deriving it from screenshots. */
  hasPhoneField: boolean;
  /** True when at least one <input> on the page has type="email" or a name /
   *  id / placeholder containing "email". */
  hasEmailField: boolean;
  /** Visible text of every link found inside a <nav> element. Used to
   *  prevent "slim the navigation" hallucinations — Claude can count the
   *  exact number of nav items instead of guessing. */
  navLinks: string[];
  /** Visible text of every <button> on the page, plus <a> elements that
   *  look CTA-like (have role="button", a class containing "btn"/"button",
   *  or text matching common CTA patterns like "Get a Demo"). Lets Claude
   *  verify a CTA exists before recommending one be added. */
  ctaTexts: string[];
  /** Every heading on the page (H1 / H2 / H3) in document order. The first
   *  and last entries tell Claude what's at the top and bottom of the
   *  page, which prevents "add a bottom CTA" hallucinations when the
   *  page already ends with a "Get started" section. */
  headings: string[];
  /** Visible text of every <a> and <button> found inside a <header>
   *  element. Many modern sites use <header> with buttons directly
   *  and skip the <nav> tag entirely — this captures the top-area
   *  navigation/CTA content so it's not mistaken for "page lacks
   *  navigation". Dedup by text. */
  headerCtaTexts: string[];
  /** Likely nav labels detected by scanning the FIRST portion of body
   *  text for common nav vocabulary (Products, Pricing, Resources,
   *  About, etc.). This catches landing-page builders (Unbounce,
   *  Instapage, etc.) that style <div> elements as nav links with no
   *  semantic <nav>/<a>/<button>/<header> markup at all. */
  likelyNavLabels: string[];
  /** Per-format image counts. Counted by extension across <img src>,
   *  <img srcset>, <source srcset>, and CSS url(...) references.
   *  Deduped by URL. Drives the Speed bullets and the WebP key
   *  takeaway. Now also surfaced to Claude in GROUND TRUTH. */
  imageFormats: ImageFormatBreakdown;
  /** Visible alt text of every <img alt="..."> on the page, deduped.
   *  Lets Claude read what the page's images are labelled as — useful
   *  for customer logos (which often have brand names in the alt) and
   *  for content / above-the-fold reasoning. */
  imageAlts: string[];
  /** Whether ANY social proof appears anywhere on the page. Derived
   *  from a body-text scan for trust markers ("Trusted by", "Used by",
   *  G2/Capterra/Trustpilot, customer counts, testimonials, etc.) AND
   *  a count of image alts that look like brand names or contain
   *  "logo". Used as ground truth so Claude doesn't recommend adding
   *  social proof when the page already has it. */
  socialProofPresent: boolean;
  /** Whether social proof appears specifically near the top of the
   *  page (heuristic for "above the fold"). Detected by scanning the
   *  first ~3000 characters of body text for trust markers AND
   *  counting logo-like image alts in the first ~8000 characters of
   *  HTML. Not pixel-accurate — we can't determine viewport position
   *  from static HTML — but a reasonable proxy. Claude should also
   *  verify visually against the above-the-fold screenshot. */
  socialProofAboveFold: boolean;
  /** Debug list of which signals fired during social-proof detection.
   *  Logged but not surfaced to Claude. */
  socialProofSignals: string[];
  /** Whether the first ~8000 characters of raw HTML contain any
   *  checkbox-style or interactive-quiz controls. A strong signal that
   *  the above-the-fold leads with an interactive experience (quiz,
   *  qualifier, multi-step form) rather than a static block — Claude
   *  should NOT penalise the above-the-fold for being "boring" /
   *  "static" / "lacking interactivity" when this is true. Detected
   *  by scanning for <input type="checkbox">, <input type="radio">,
   *  role="checkbox" / role="radio", and class/text patterns like
   *  "checkbox", "radio-button", "quiz-option", "multi-step". */
  hasInteractiveAboveFold: boolean;
  /** Debug list of which interactive-control signals fired. Logged but
   *  not surfaced to Claude. */
  interactiveAboveFoldSignals: string[];
  /** True when the static HTML fetch returned a client-rendered SPA
   *  shell with little to no visible text — meaning React / Vue /
   *  Angular / Svelte / similar is expected to inject the content
   *  client-side via JavaScript, which our server-side `fetch()` does
   *  NOT execute. Detected by: bodyText word count below the SPA
   *  threshold AND a framework-shell signature in the raw HTML (an
   *  empty root container, framework-named globals, or named bundler
   *  artefacts). When TRUE, the HTML-derived ground-truth flags
   *  (socialProofPresent, socialProofAboveFold, hasInteractiveAboveFold,
   *  image alts, body-text counts) may underreport — Claude is told
   *  to defer to the screenshots in that case. */
  isClientRenderedShell: boolean;
  /** Debug list of which SPA-shell signals fired. Logged but not
   *  surfaced to Claude. */
  clientRenderedSignals: string[];
}

/** Per-format image inventory. Counts are deduped by URL (case-
 *  insensitive, query strings stripped) so the same image referenced
 *  multiple times only counts once. Derived sums let consumers ask
 *  "how many legacy-raster images are on the page?" without re-adding. */
export interface ImageFormatBreakdown {
  png: number;
  jpeg: number;
  gif: number;
  webp: number;
  avif: number;
  svg: number;
  /** Sum of png + jpeg + gif (raster formats that have a modern
   *  replacement). */
  legacyRaster: number;
  /** Sum of webp + avif (modern raster formats). */
  modernRaster: number;
}

export interface FormFieldSummary {
  /** input/textarea/select. */
  tag: string;
  /** type attribute when present (text, email, tel, password, etc.). */
  type: string | null;
  /** name attribute when present. */
  name: string | null;
  /** id attribute when present. */
  id: string | null;
  /** placeholder attribute when present. */
  placeholder: string | null;
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      // Pretend to be a real browser — some sites 403 the default Node UA.
      "User-Agent":
        "Mozilla/5.0 (compatible; PageTestBot/1.0; +https://pagetest.revenuagency.io)",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(20_000),
  });

  const contentType = res.headers.get("content-type");
  // Read up to MAX_HTML_BYTES — large pages would blow up our prompt.
  const reader = res.body?.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_HTML_BYTES) {
        chunks.push(value.slice(0, MAX_HTML_BYTES - (received - value.byteLength)));
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
  }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(
    concatBuffers(chunks),
  );

  return {
    finalUrl: res.url,
    status: res.status,
    contentType,
    html,
    bodyText: extractBodyText(html),
    title: extractTitle(html),
    metaDescription: extractMetaDescription(html),
    structure: extractStructure(html),
  };
}

function concatBuffers(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Best-available page title. Tries in order:
 *   1. <title>...</title>
 *   2. <meta property="og:title" content="...">
 *   3. <meta name="twitter:title" content="...">
 *
 * Modern SPAs and client-rendered sites often ship with an empty or
 * placeholder <title> in the initial HTML (the real title is set by JS
 * after hydration). The og:title / twitter:title meta tags are usually
 * SSR'd because social-media previews depend on them, so they're our
 * best fallback for the actual page title.
 *
 * Strings that look like a placeholder ("App", "Loading", "Untitled",
 * the URL itself, or the bare hostname) are rejected so we fall through
 * to the next source instead of saving "App" as the report name.
 */
function extractTitle(html: string): string | null {
  const candidates: string[] = [];

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) candidates.push(decodeEntities(stripTags(titleMatch[1])).trim());

  // og:title — property can come before OR after content; cover both orders.
  const ogA = html.match(
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
  );
  const ogB = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
  );
  if (ogA) candidates.push(decodeEntities(ogA[1]).trim());
  if (ogB) candidates.push(decodeEntities(ogB[1]).trim());

  // twitter:title — same dual-order handling.
  const twA = html.match(
    /<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i,
  );
  const twB = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i,
  );
  if (twA) candidates.push(decodeEntities(twA[1]).trim());
  if (twB) candidates.push(decodeEntities(twB[1]).trim());

  for (const c of candidates) {
    if (isUsableTitle(c)) return c;
  }
  return null;
}

/** Reject SPA placeholder titles so we fall through to the next source. */
function isUsableTitle(s: string): boolean {
  if (!s) return false;
  const lower = s.toLowerCase().trim();
  if (lower.length === 0) return false;
  // Common placeholder values shipped in the initial HTML of SPAs.
  const placeholders = new Set([
    "app",
    "loading",
    "loading…",
    "loading...",
    "untitled",
    "document",
    "react app",
    "vite",
    "vite + react",
    "vite + vue",
    "create react app",
    "next.js",
    "nuxt",
    "sveltekit",
    "home",
  ]);
  if (placeholders.has(lower)) return false;
  return true;
}

function extractMetaDescription(html: string): string | null {
  const m = html.match(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
  );
  if (m) return decodeEntities(m[1]).trim();
  const m2 = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
  );
  return m2 ? decodeEntities(m2[1]).trim() : null;
}

function extractBodyText(html: string): string {
  // Drop scripts, styles, noscript, svg, iframe content before stripping tags.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = decodeEntities(stripTags(cleaned))
    .replace(/\s+/g, " ")
    .trim();
  // Cap at 60k chars so Claude sees the entire page top to bottom —
  // forms in the footer, FAQ sections, social-proof logo captions all
  // count. The Anthropic context window easily fits this.
  return text.length > 60_000 ? text.slice(0, 60_000) + " …" : text;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function extractStructure(html: string): PageStructure {
  const count = (re: RegExp) => (html.match(re) ?? []).length;
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  const imgMissingAlt = imgTags.filter(
    (t) => !/\balt\s*=\s*["'][^"']/i.test(t),
  ).length;
  const bodyText = extractBodyText(html);
  const formFields = extractFormFields(html);
  const navLinks = extractNavLinks(html);
  const ctaTexts = extractCtaTexts(html);
  const headings = extractHeadings(html);
  const headerCtaTexts = extractHeaderCtaTexts(html);
  const likelyNavLabels = detectLikelyNavLabels(bodyText);
  const imageFormats = scanImageFormats(html);
  const imageAlts = extractImageAlts(html);
  const socialProof = detectSocialProof(html, bodyText, imageAlts);
  const interactiveAtf = detectInteractiveAboveFold(html);
  const spaShell = detectClientRenderedShell(html, bodyText);

  // Derive blunt yes/no signals for the most-hallucinated fields. Claude
  // gets these as ground truth so it can't claim "the form asks for a
  // phone number" when there is no tel input anywhere on the page.
  const looksLikePhone = (f: FormFieldSummary): boolean => {
    if (f.type === "tel") return true;
    const combined = `${f.name ?? ""} ${f.id ?? ""} ${f.placeholder ?? ""}`.toLowerCase();
    return /\b(phone|tel|mobile|cell|whatsapp)\b/.test(combined);
  };
  const looksLikeEmail = (f: FormFieldSummary): boolean => {
    if (f.type === "email") return true;
    const combined = `${f.name ?? ""} ${f.id ?? ""} ${f.placeholder ?? ""}`.toLowerCase();
    return /\bemail\b|\be-?mail\b/.test(combined);
  };

  return {
    h1Count: count(/<h1\b/gi),
    h2Count: count(/<h2\b/gi),
    h3Count: count(/<h3\b/gi),
    paragraphCount: count(/<p\b/gi),
    imgCount: imgTags.length,
    imgMissingAlt,
    linkCount: count(/<a\b[^>]*\bhref\s*=/gi),
    buttonCount:
      count(/<button\b/gi) + count(/<input\b[^>]+type\s*=\s*["']button/gi) +
      count(/<input\b[^>]+type\s*=\s*["']submit/gi),
    formCount: count(/<form\b/gi),
    inputCount: count(/<input\b/gi) + count(/<textarea\b/gi) + count(/<select\b/gi),
    hasNav: /<nav\b/i.test(html),
    hasFooter: /<footer\b/i.test(html),
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    formFields,
    hasPhoneField: formFields.some(looksLikePhone),
    hasEmailField: formFields.some(looksLikeEmail),
    navLinks,
    ctaTexts,
    headings,
    headerCtaTexts,
    likelyNavLabels,
    imageFormats,
    imageAlts,
    socialProofPresent: socialProof.presentOnSite,
    socialProofAboveFold: socialProof.aboveTheFold,
    socialProofSignals: socialProof.signals,
    hasInteractiveAboveFold: interactiveAtf.present,
    interactiveAboveFoldSignals: interactiveAtf.signals,
    isClientRenderedShell: spaShell.present,
    clientRenderedSignals: spaShell.signals,
  };
}

/**
 * Detect whether the page has social proof, and whether it appears
 * above the fold.
 *
 * Two-tier check:
 *
 * 1. PRESENT-ON-SITE — fires when ANY of these are found anywhere on
 *    the page:
 *      - Body text contains trust markers (Trusted by, Used by,
 *        G2/Capterra/Trustpilot, customer counts, case studies,
 *        testimonials, named ratings).
 *      - At least 3 image alts look like brand names ("Coca-Cola",
 *        "Microsoft logo") or contain logo/customer/partner/client.
 *      - At least 5 images appear in close DOM proximity inside the
 *        same container (heuristic for a logo strip).
 *
 * 2. ABOVE-THE-FOLD — fires when ANY of these are found in the FIRST
 *    portion of the page:
 *      - First ~3000 chars of body text contain a trust marker.
 *      - First ~8000 chars of HTML contain ≥2 logo-like image alts.
 *
 * Above-the-fold is heuristic — we can't determine actual viewport
 * position from static HTML. Claude's vision on the screenshot is the
 * tiebreaker. These flags just give Claude a fact-anchored baseline.
 */
const SOCIAL_PROOF_TEXT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "trusted-by", re: /\btrusted by\b/i },
  { name: "used-by", re: /\bused by\b/i },
  { name: "loved-by", re: /\bloved by\b/i },
  { name: "rating-out-of", re: /\b\d+(\.\d+)?\s*\/\s*(5|10)\b/i },
  { name: "g2", re: /\bg2\b/i },
  { name: "capterra", re: /\bcapterra\b/i },
  { name: "trustpilot", re: /\btrustpilot\b/i },
  { name: "gartner", re: /\bgartner\b/i },
  { name: "forrester", re: /\bforrester\b/i },
  { name: "customer-count", re: /\b\d{2,}[+]?\s*(customers?|clients?|teams?|companies|brands?|hospitals?|practices?|users?|members?)\b/i },
  { name: "percent-customers", re: /\b\d+%\s+(of\s+)?(customers?|users?|teams?|companies)/i },
  { name: "case-studies", re: /\bcase studies?\b/i },
  { name: "testimonials", re: /\btestimonials?\b/i },
  { name: "named-reviews", re: /\b\d+\s+reviews?\b/i },
];

/** Returns true if an alt string looks like a brand name or a logo. */
function looksLikeLogoAlt(alt: string): boolean {
  if (!alt) return false;
  const trimmed = alt.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  // Explicit logo / customer / partner mentions.
  if (/\b(logo|customer|partner|client|brand)\b/i.test(trimmed)) return true;
  // Capitalised 1-3 word phrases — likely brand names ("Coca-Cola",
  // "Lionsgate", "Frontier"). Allow hyphens and ampersands.
  if (/^[A-Z][A-Za-z0-9&\-]+(?:\s+[A-Z][A-Za-z0-9&\-]+){0,2}$/.test(trimmed)) {
    return true;
  }
  return false;
}

function detectSocialProof(
  html: string,
  bodyText: string,
  imageAlts: string[],
): { presentOnSite: boolean; aboveTheFold: boolean; signals: string[] } {
  const signals: string[] = [];

  // Body-text scan, full page.
  let textHit = false;
  for (const { name, re } of SOCIAL_PROOF_TEXT_PATTERNS) {
    if (re.test(bodyText)) {
      signals.push(`text:${name}`);
      textHit = true;
    }
  }

  // Image-alt brand-likeness check, full page.
  const brandyAlts = imageAlts.filter(looksLikeLogoAlt);
  if (brandyAlts.length >= 3) {
    signals.push(`alts:${brandyAlts.length}-brand-like`);
  }

  const presentOnSite = textHit || brandyAlts.length >= 3;

  // Above-the-fold heuristic: first chunk of body text + first chunk
  // of HTML.
  const headBody = bodyText.slice(0, 3000);
  let atfTextHit = false;
  for (const { name, re } of SOCIAL_PROOF_TEXT_PATTERNS) {
    if (re.test(headBody)) {
      signals.push(`atf-text:${name}`);
      atfTextHit = true;
      break;
    }
  }

  const headHtml = html.slice(0, 8000);
  const earlyAltMatches = Array.from(
    headHtml.matchAll(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi),
  );
  const earlyBrandyAlts = earlyAltMatches
    .map((m) => decodeEntities(m[1] ?? "").trim())
    .filter(looksLikeLogoAlt);
  if (earlyBrandyAlts.length >= 2) {
    signals.push(`atf-alts:${earlyBrandyAlts.length}-brand-like`);
  }

  const aboveTheFold = atfTextHit || earlyBrandyAlts.length >= 2;

  return { presentOnSite, aboveTheFold, signals };
}

/**
 * Detect whether the FIRST chunk of raw HTML contains interactive
 * controls that would make the above-the-fold feel like a quiz /
 * qualifier / multi-step form rather than a static block.
 *
 * Why this matters: Claude tends to dock the above-the-fold score
 * when it can't see an obvious primary CTA or hero copy, even when
 * the page is intentionally leading with an interactive flow (where
 * the CTA is the next quiz step). This flag tells Claude "the above
 * the fold IS the interaction" so it stops asking for a static
 * headline + CTA combo.
 *
 * Heuristic: scan first 8,000 characters of raw HTML for any of:
 *   - <input type="checkbox"> or <input type="radio">
 *   - role="checkbox" / role="radio"
 *   - class names containing checkbox / radio-button / quiz-option
 *   - text/aria patterns that hint at multi-step flows
 *     ("Step 1 of", "Select all that apply", "Next step")
 *
 * Not pixel-accurate — same caveat as social-proof-above-fold — but
 * a reasonable proxy given we can't determine viewport position from
 * static HTML.
 */
const INTERACTIVE_ATF_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "input-checkbox", re: /<input\b[^>]*\btype\s*=\s*["']checkbox["']/i },
  { name: "input-radio", re: /<input\b[^>]*\btype\s*=\s*["']radio["']/i },
  { name: "role-checkbox", re: /\brole\s*=\s*["']checkbox["']/i },
  { name: "role-radio", re: /\brole\s*=\s*["']radio["']/i },
  { name: "class-checkbox", re: /\bclass\s*=\s*["'][^"']*\bcheckbox\b[^"']*["']/i },
  { name: "class-radio-button", re: /\bclass\s*=\s*["'][^"']*\bradio[-_]?button\b[^"']*["']/i },
  { name: "class-quiz-option", re: /\bclass\s*=\s*["'][^"']*\bquiz[-_]?option\b[^"']*["']/i },
  { name: "class-multi-step", re: /\bclass\s*=\s*["'][^"']*\bmulti[-_]?step\b[^"']*["']/i },
  { name: "step-counter", re: /\bstep\s+\d+\s+of\s+\d+\b/i },
  { name: "select-all-apply", re: /\bselect\s+all\s+that\s+apply\b/i },
  { name: "next-step-cta", re: /\b(next\s+step|continue\s+to\s+step|begin\s+quiz|start\s+the\s+quiz)\b/i },
];

function detectInteractiveAboveFold(
  html: string,
): { present: boolean; signals: string[] } {
  const signals: string[] = [];
  const head = html.slice(0, 8000);
  for (const { name, re } of INTERACTIVE_ATF_PATTERNS) {
    if (re.test(head)) signals.push(name);
  }
  return { present: signals.length > 0, signals };
}

/**
 * Detect whether the static HTML response is a client-rendered SPA
 * shell with no meaningful server-rendered content.
 *
 * Why this matters: every ground-truth flag derived from the raw HTML
 * (social proof, interactive AtF, image alts, body text excerpts) is
 * derived from what the server actually returned in the initial HTML
 * payload. For server-rendered sites (most marketing pages, Webflow,
 * Unbounce, Next.js with SSR, etc.) that's effectively the whole page.
 * For pure client-rendered SPAs (Create React App, plain Vite SPA,
 * client-only single-page Vue) the initial HTML is a shell — usually
 * `<div id="root"></div>` plus a script tag — and the actual content
 * is injected by JavaScript that our server-side `fetch()` does NOT
 * execute. On those sites, the flags can underreport real content.
 *
 * The fix isn't to make the flags more accurate (we can't, without
 * running a headless browser). It's to TELL Claude when the HTML was
 * thin so it knows to defer to the screenshots, which DO render JS.
 *
 * Signal: bodyText word count is unusually low (under SPA_WORD_THRESHOLD)
 * AND the HTML carries at least one framework-shell signature. Both
 * have to be true to avoid false positives on simple static pages that
 * just happen to have few words (a 404 page, a landing page with a
 * single CTA, etc.).
 */
const SPA_WORD_THRESHOLD = 50;
const SPA_SHELL_PATTERNS: { name: string; re: RegExp }[] = [
  // Common framework root-container ids.
  { name: "root-empty", re: /<div\b[^>]*\bid\s*=\s*["']root["'][^>]*>\s*<\/div>/i },
  { name: "next-empty", re: /<div\b[^>]*\bid\s*=\s*["']__next["'][^>]*>\s*<\/div>/i },
  { name: "app-empty", re: /<div\b[^>]*\bid\s*=\s*["']app["'][^>]*>\s*<\/div>/i },
  { name: "svelte-empty", re: /<div\b[^>]*\bid\s*=\s*["']svelte["'][^>]*>\s*<\/div>/i },
  // Framework hydration markers / globals that strongly imply client
  // rendering even when the root isn't literally empty.
  { name: "react-noscript", re: /<noscript>\s*[^<]*React[^<]*<\/noscript>/i },
  { name: "next-data", re: /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__/i },
  { name: "nuxt-data", re: /window\.__NUXT__/ },
  { name: "vite-client", re: /\/@vite\/client/ },
  { name: "webpack-runtime", re: /webpackChunk|__webpack_require__/ },
  // Bundled / hashed JS bundle names — characteristic of SPA builds.
  { name: "hashed-js-bundle", re: /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/(main|app|index|bundle|chunk)[.\-_][a-f0-9]{6,}\.js/i },
];

function detectClientRenderedShell(
  html: string,
  bodyText: string,
): { present: boolean; signals: string[] } {
  const signals: string[] = [];
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  if (wordCount >= SPA_WORD_THRESHOLD) {
    return { present: false, signals };
  }
  signals.push(`words:${wordCount}`);
  for (const { name, re } of SPA_SHELL_PATTERNS) {
    if (re.test(html)) signals.push(name);
  }
  // Need at least one framework signature in addition to the low word
  // count to call it. Otherwise a one-line legitimate landing page
  // would trip the flag.
  const hasFrameworkSignal = signals.some((s) => s !== `words:${wordCount}`);
  return { present: hasFrameworkSignal, signals };
}

/**
 * Walk the HTML and count image references by format. Used to drive
 * the Speed bullets, the WebP key takeaway, and the GROUND TRUTH
 * image-format breakdown. Counts dedupe by URL (case-insensitive,
 * query strings stripped) so the same image referenced multiple
 * times only counts once. SVG is included because the user wants the
 * full picture; it's vector and doesn't need conversion.
 */
function scanImageFormats(html: string): ImageFormatBreakdown {
  const empty: ImageFormatBreakdown = {
    png: 0,
    jpeg: 0,
    gif: 0,
    webp: 0,
    avif: 0,
    svg: 0,
    legacyRaster: 0,
    modernRaster: 0,
  };
  if (!html) return empty;

  const seen: Record<string, Set<string>> = {
    png: new Set(),
    jpeg: new Set(),
    gif: new Set(),
    webp: new Set(),
    avif: new Set(),
    svg: new Set(),
  };

  const EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg)(?:\?|$|"|'|\))/i;

  const collect = (value: string | undefined | null): void => {
    if (!value) return;
    const candidates = value.split(/,\s*/).map((c) => c.trim().split(/\s+/)[0]);
    for (const raw of candidates) {
      if (!raw) continue;
      const m = raw.match(EXT_RE);
      if (!m) continue;
      const ext = m[1].toLowerCase().replace(/^jpg$/, "jpeg");
      const normalised = raw.split("?")[0].toLowerCase();
      if (seen[ext]) seen[ext].add(normalised);
    }
  };

  for (const m of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    collect(m[1]);
  }
  for (const m of html.matchAll(/<img\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/gi)) {
    collect(m[1]);
  }
  for (const m of html.matchAll(
    /<source\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/gi,
  )) {
    collect(m[1]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    collect(m[1]);
  }

  const png = seen.png.size;
  const jpeg = seen.jpeg.size;
  const gif = seen.gif.size;
  const webp = seen.webp.size;
  const avif = seen.avif.size;
  const svg = seen.svg.size;
  return {
    png,
    jpeg,
    gif,
    webp,
    avif,
    svg,
    legacyRaster: png + jpeg + gif,
    modernRaster: webp + avif,
  };
}

/**
 * Extract non-empty alt attributes from every <img> on the page. Many
 * customer-logo strips put the brand name in the alt ("Coca-Cola
 * logo"), and hero images often describe what's shown ("Dashboard
 * showing real-time scheduling"). Giving Claude these strings lets it
 * reason about brand-named social proof and image content without
 * having to read the screenshot. Deduped by string. Capped at 40.
 */
function extractImageAlts(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi)) {
    const text = decodeEntities(m[1] ?? "").trim();
    if (!text || text.length > 120) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 40) break;
  }
  return out;
}

/** Strip HTML tags, decode entities, collapse whitespace. Used when we
 *  need the visible text of a single element (heading, link, button). */
function cleanInlineText(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

/**
 * Every visible-ish <a> link found inside a <nav>. Filters that bring
 * the count in line with what a human actually sees on the page:
 *
 *   - "Skip to ..." accessibility links (visually hidden screen-reader
 *     shortcuts). Skipped.
 *   - "Log in" / "Sign in" / "Sign up" / "My account" / etc. — these
 *     are for EXISTING users, not visitor navigation, and we already
 *     never want to recommend them as positive CTAs. Skipped.
 *   - Cross-nav duplicates. Many sites ship duplicate copies of the
 *     same nav for desktop and mobile-menu states; we dedupe by text
 *     so we never count the same label twice.
 *
 * The unfiltered count was producing reports like "Navigation carries
 * 11 links" on monday.com — the page only has 2 visible nav items;
 * the other 9 were skip-links and hidden mobile-menu items.
 */
const NAV_LINK_NOISE = /^(skip(?:\s+to)?(?:\s+(?:main\s+)?(?:content|footer|nav(?:igation)?))?|skip\s+navigation|log\s*in|login|sign\s*in|signin|sign\s*up|signup|create\s+account|register|log\s*out|logout|my\s+account|go\s+to\s+my\s+account|account|go\s+to\s+homepage|go\s+to\s+home)$/i;

function extractNavLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Match every <nav>...</nav> block (non-greedy, multi-line).
  for (const navMatch of html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)) {
    const navInner = navMatch[1] ?? "";
    for (const linkMatch of navInner.matchAll(
      /<a\b[^>]*\bhref\s*=\s*["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const text = cleanInlineText(linkMatch[1] ?? "");
      if (!text || text.length > 60) continue;
      if (NAV_LINK_NOISE.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/** Visible text of every CTA-like element on the page:
 *   - <button> elements
 *   - <input type="submit|button"> values
 *   - <a> elements that look CTA-like (role=button, "btn"/"button" class,
 *     or text matching common CTA patterns)
 *  Deduped by text. */
function extractCtaTexts(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const text = cleanInlineText(raw);
    if (!text || text.length > 60) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
    add(m[1] ?? "");
  }
  for (const m of html.matchAll(
    /<input\b[^>]*\btype\s*=\s*["'](?:submit|button)["'][^>]*\bvalue\s*=\s*["']([^"']+)["']/gi,
  )) {
    add(m[1] ?? "");
  }
  // CTA-like anchors. We pick anchors that either have a role=button,
  // a class containing "btn" or "button", OR text matching common CTA
  // patterns (Book, Demo, Get, Start, Try, Sign up, Schedule, Contact,
  // Buy, Download, Subscribe, etc.).
  const CTA_TEXT = /\b(book|demo|get\s+(?:a\s+)?(?:demo|started|in\s+touch)|start|try|sign\s*up|schedule|contact|buy|download|subscribe|join|request|talk\s+to)\b/i;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] ?? "";
    const text = cleanInlineText(m[2] ?? "");
    if (!text) continue;
    const isButtonish =
      /\brole\s*=\s*["']button["']/i.test(attrs) ||
      /\bclass\s*=\s*["'][^"']*\b(?:btn|button|cta)\b/i.test(attrs) ||
      CTA_TEXT.test(text);
    if (!isButtonish) continue;
    add(text);
    if (out.length >= 40) return out;
  }
  return out;
}

/**
 * Visible text of every <a> and <button> found INSIDE a <header>
 * element. Modern sites often use <header> directly with buttons
 * (e.g. <header><img class="logo" /><a class="cta">Get a Demo</a></header>)
 * with no <nav> tag at all. Without this, our nav signal can mislead
 * Claude into saying "page lacks navigation" when the page clearly has
 * a top-area CTA — the header just isn't tagged semantically.
 *
 * Deduped by text. Capped at 30 entries.
 */
function extractHeaderCtaTexts(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const text = cleanInlineText(raw);
    if (!text || text.length > 60) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  for (const headerMatch of html.matchAll(
    /<header\b[^>]*>([\s\S]*?)<\/header>/gi,
  )) {
    const headerInner = headerMatch[1] ?? "";
    for (const m of headerInner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      add(m[1] ?? "");
      if (out.length >= 30) return out;
    }
    for (const m of headerInner.matchAll(
      /<button\b[^>]*>([\s\S]*?)<\/button>/gi,
    )) {
      add(m[1] ?? "");
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/**
 * Detect nav-like labels from the FIRST portion of body text. This is
 * a fallback for landing-page builders (Unbounce, Instapage, etc.) that
 * style <div> elements as nav links and ship pages with zero semantic
 * <nav>/<header>/<a>/<button> markup. Our DOM extractors find nothing
 * on those pages, even though the screenshot clearly shows a nav.
 *
 * Strategy: take the first ~800 chars of body text and look for any
 * of the common navigation vocabulary as standalone phrases. Match the
 * phrase against word boundaries so "Products" doesn't accidentally
 * match inside "Product Updates". Return at most 8 unique labels.
 */
const COMMON_NAV_LABELS: string[] = [
  "Products",
  "Product",
  "Pricing",
  "Features",
  "Solutions",
  "Solution",
  "Resources",
  "Resource Center",
  "Resource Hub",
  "Blog",
  "About",
  "About Us",
  "Contact",
  "Contact Us",
  "Company",
  "Platform",
  "Customers",
  "Case Studies",
  "Use Cases",
  "Industries",
  "Integrations",
  "Docs",
  "Documentation",
  "Community",
  "Support",
  "Help",
  "Help Center",
  "Who We Serve",
  "What We Do",
  "How It Works",
  "Why Us",
  "Why Choose Us",
  "Our Story",
  "Team",
  "Careers",
  "News",
  "Press",
  "Partners",
  "Demo",
];

function detectLikelyNavLabels(bodyText: string): string[] {
  if (!bodyText) return [];
  // Take the first chunk of body text — nav labels appear near the
  // page start in body order.
  const head = bodyText.slice(0, 800);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of COMMON_NAV_LABELS) {
    // Word-boundary match, case-insensitive. We use [\\s\\b] around the
    // phrase so "Products" doesn't match inside "Product Updates".
    const re = new RegExp(`(^|\\W)${label.replace(/\s+/g, "\\s+")}(\\W|$)`, "i");
    if (re.test(head)) {
      const key = label.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(label);
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

/** Every heading on the page (H1/H2/H3) in document order. */
function extractHeadings(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const text = cleanInlineText(m[1] ?? "");
    if (!text || text.length > 200) continue;
    out.push(text);
    if (out.length >= 80) return out;
  }
  return out;
}

/**
 * Pull every form field on the page with its identifying attributes.
 * Used as ground-truth context for the Claude prompt so it never has to
 * guess what fields the page's forms actually ask for.
 */
function extractFormFields(html: string): FormFieldSummary[] {
  const fields: FormFieldSummary[] = [];
  const re = /<(input|textarea|select)\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const attr = (name: string): string | null => {
      const mm = attrs.match(
        new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"),
      );
      return mm ? mm[1] : null;
    };
    const type = attr("type");
    // Skip pure UI inputs that aren't real form fields visitors fill in.
    if (
      type === "hidden" ||
      type === "submit" ||
      type === "button" ||
      type === "reset" ||
      type === "image"
    ) {
      continue;
    }
    fields.push({
      tag,
      type,
      name: attr("name"),
      id: attr("id"),
      placeholder: attr("placeholder"),
    });
    // Hard cap so an outlier page with hundreds of inputs can't blow up
    // the prompt payload.
    if (fields.length >= 60) break;
  }
  return fields;
}
