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
  };
}

/** Strip HTML tags, decode entities, collapse whitespace. Used when we
 *  need the visible text of a single element (heading, link, button). */
function cleanInlineText(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

/** Every <a> link found inside a <nav>. Dedupes by text. */
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
