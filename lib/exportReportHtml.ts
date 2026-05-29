/**
 * Client-side HTML export for the report view.
 *
 * The output is a single self-contained .html file. Double-clicking it
 * opens the report in any browser with no network connection — every
 * stylesheet is inlined as a <style> block, every external image
 * (Microlink screenshots, fox illustration, etc.) is embedded as a
 * data URI, and the JavaScript runtime is stripped out so it's a
 * static snapshot.
 *
 * Flow:
 *   1. Open every <details> inside the target so all sections render.
 *   2. Add the "pdf-printing" body class so the same UI-chrome rules
 *      that hide carousel arrows / copy buttons / the rerun row
 *      apply, then unfold the Analysis carousel into a static grid.
 *   3. Wait for repaint; fetch and inline every cross-origin image
 *      as a data URI (Microlink screenshots etc.).
 *   4. Clone the target node and the document's stylesheets into a
 *      brand-new HTML document.
 *   5. Restore everything we changed.
 */

/**
 * Force the TOP-LEVEL <details> open inside `root`, but leave any
 * nested <details> at their current state. This means each report
 * section (Overview, Key Recommendations, Analysis, Above-the-Fold
 * Screenshots, PageSpeed Insights, Technical Improvements) opens by
 * default — but the expandable per-improvement rows inside Technical
 * Improvements stay closed so the reader can choose which ones to open.
 *
 * Returns a restore function that puts every touched element back to
 * its previous open/closed state.
 */
function openTopLevelDetails(root: HTMLElement): () => void {
  const previous: Array<{ el: HTMLDetailsElement; wasOpen: boolean }> = [];
  for (const el of Array.from(root.querySelectorAll<HTMLDetailsElement>("details"))) {
    // Skip any <details> that has another <details> as an ancestor
    // (i.e. it's nested) — those should stay at their natural state.
    if (el.parentElement?.closest("details")) continue;
    previous.push({ el, wasOpen: el.open });
    el.open = true;
  }
  return () => {
    for (const { el, wasOpen } of previous) {
      el.open = wasOpen;
    }
  };
}

function markPrinting(): () => void {
  document.body.classList.add("pdf-printing");
  return () => document.body.classList.remove("pdf-printing");
}

/** Inline external images as data URIs (in place). Returns a restore fn
 *  that puts the original srcs back. */
async function inlineExternalImages(root: HTMLElement): Promise<() => void> {
  const restores: Array<{ el: HTMLImageElement; original: string }> = [];
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.src;
      if (!src) return;
      if (src.startsWith("data:")) return;
      // Same-origin images get fetched too so the exported HTML is
      // truly offline-capable (no /_next/static/... reference needed).
      try {
        const res = await fetch(src, { mode: "cors", credentials: "omit" });
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        restores.push({ el: img, original: img.src });
        img.src = dataUrl;
        await new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve();
          else {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }
        });
      } catch {
        // Leave original src; the standalone HTML may show a broken
        // image for this one but the rest still renders.
      }
    }),
  );
  return () => {
    for (const { el, original } of restores) {
      el.src = original;
    }
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function waitForRepaint(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Fetch every same-origin stylesheet referenced by the page and
 * concatenate the CSS into one string. Also pulls inline <style>
 * blocks. Used to give the standalone HTML the same look as the live
 * report without depending on any /_next/static/css/... paths.
 */
async function collectAllCss(): Promise<string> {
  const parts: string[] = [];

  // Inline <style> blocks.
  for (const style of Array.from(document.querySelectorAll("style"))) {
    parts.push(style.textContent ?? "");
  }

  // <link rel="stylesheet" href="..."> — fetch each and inline.
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>("link[rel='stylesheet']"),
  );
  await Promise.all(
    links.map(async (link) => {
      if (!link.href) return;
      try {
        const res = await fetch(link.href, { mode: "cors", credentials: "omit" });
        if (!res.ok) return;
        const text = await res.text();
        parts.push(`/* from ${link.href} */\n${text}`);
      } catch {
        // Ignore — likely a cross-origin stylesheet (Google Fonts, etc.)
        // that doesn't permit CORS. The standalone HTML will fall back
        // to system fonts for that block.
      }
    }),
  );

  return parts.join("\n\n");
}

/**
 * Walk the cloned subtree and replace each external <img src> with the
 * data URI we already loaded into the corresponding live element. This
 * is necessary because cloneNode copies the original src attribute, not
 * the current `img.src` property in some browsers when the src was
 * changed via JS.
 */
function copyInlinedImageSrcs(live: HTMLElement, cloned: HTMLElement): void {
  const liveImgs = Array.from(live.querySelectorAll("img"));
  const clonedImgs = Array.from(cloned.querySelectorAll("img"));
  const n = Math.min(liveImgs.length, clonedImgs.length);
  for (let i = 0; i < n; i++) {
    const liveSrc = liveImgs[i].src;
    if (liveSrc.startsWith("data:")) {
      clonedImgs[i].setAttribute("src", liveSrc);
    }
  }
}

export interface ExportHtmlOptions {
  target: HTMLElement;
  /** Used for the <title> tag of the standalone document. */
  documentTitle: string;
}

/**
 * Render the target as a fully self-contained HTML document. Returns
 * the HTML as a Blob ready to download. The user double-clicks the
 * saved file and it opens in any browser, fully styled, with no
 * network requests.
 */
export async function renderReportToHtml({
  target,
  documentTitle,
}: ExportHtmlOptions): Promise<Blob> {
  const restoreDetails = openTopLevelDetails(target);
  const restorePrinting = markPrinting();

  let restoreImages: (() => void) | null = null;
  try {
    await waitForRepaint();
    restoreImages = await inlineExternalImages(target);
    await waitForRepaint();

    // Snapshot CSS while the page is in "pdf-printing" mode so all the
    // pdf-printing rules are part of the resulting stylesheet.
    const css = await collectAllCss();

    // Clone the target and ensure inlined image data URIs make it into
    // the clone (some browsers copy the original src attribute on
    // cloneNode rather than the live `img.src` property).
    const cloned = target.cloneNode(true) as HTMLElement;
    copyInlinedImageSrcs(target, cloned);

    // Strip <script> tags from the clone — the standalone HTML should
    // be a static snapshot, not the running app.
    for (const s of Array.from(cloned.querySelectorAll("script"))) {
      s.remove();
    }

    // Strip nav links that point inside the live app and won't work in
    // a static HTML file. Specifically: the "saved reports" icon
    // (href="/reports") in the header. Identified by href and by the
    // aria-label / title we set in components/Header.tsx.
    const savedReportsLinks = Array.from(
      cloned.querySelectorAll<HTMLAnchorElement>(
        'a[href="/reports"], a[aria-label*="saved reports" i], a[title*="saved reports" i]',
      ),
    );
    for (const link of savedReportsLinks) {
      link.remove();
    }

    // Build a complete HTML document. Use the same body bg colour as
    // the live page so the export looks identical at first paint.
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle)}</title>
<style>
/* Inlined stylesheets from the live page. */
${css}

/* Body backdrop matches the live app bg. */
html, body { background: #FCF7F5; margin: 0; padding: 0; }
/* Force the "pdf-printing" mode so the carousel grid + hidden chrome
   are baked into the static export. */
body { }
</style>
</head>
<body class="pdf-printing">
${cloned.outerHTML}
</body>
</html>`;

    return new Blob([html], { type: "text/html;charset=utf-8" });
  } finally {
    restoreImages?.();
    restoreDetails();
    restorePrinting();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Trigger a download for the given Blob. */
export function triggerHtmlDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.html`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
