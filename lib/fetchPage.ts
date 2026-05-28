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

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(stripTags(m[1])).trim() : null;
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
  };
}
