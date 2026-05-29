/**
 * Client-side PDF export for the report view.
 *
 * Goal: the PDF should look identical to a screenshot of the report
 * with every section expanded. To achieve that we:
 *
 *   1. Force every <details> inside the target node to OPEN so all
 *      sections render in the PDF.
 *   2. Add a "pdf-printing" class to <body> so global CSS hides UI
 *      chrome (carousel arrows, copy buttons, the rerun/download row)
 *      and unfolds the Breakdown carousel into a static grid.
 *   3. Inline every cross-origin image (Microlink screenshots) as a
 *      data URI so html2canvas doesn't render them as blank squares
 *      under its CORS rules.
 *   4. Run html2canvas at 3x scale for crisp output, then place the
 *      single tall image into a PDF page that's exactly the height of
 *      the content — one long page that reads like a screenshot.
 *   5. Restore everything we changed (open/closed details, original
 *      image srcs).
 */

/** Force all <details> open inside `root` and return a restore function. */
function openAllDetails(root: HTMLElement): () => void {
  const previous: Array<{ el: HTMLDetailsElement; wasOpen: boolean }> = [];
  const detailsList = root.querySelectorAll<HTMLDetailsElement>("details");
  for (const el of Array.from(detailsList)) {
    previous.push({ el, wasOpen: el.open });
    el.open = true;
  }
  return () => {
    for (const { el, wasOpen } of previous) {
      el.open = wasOpen;
    }
  };
}

/** Add a marker class to <body> so global CSS can hide UI chrome
 *  during the PDF render. Returns a function that removes the class. */
function markPrinting(): () => void {
  document.body.classList.add("pdf-printing");
  return () => document.body.classList.remove("pdf-printing");
}

/** Pause animations + transitions while we capture so screenshots
 *  don't catch mid-frame states. */
function freezeAnimations(): () => void {
  const style = document.createElement("style");
  style.dataset.pdfPause = "1";
  style.textContent = `
    .pdf-printing * {
      animation-play-state: paused !important;
      transition: none !important;
    }
  `;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}

/**
 * Inline cross-origin images as data URIs. html2canvas can't capture
 * tainted canvases, and Microlink's CDN doesn't always send CORS
 * headers, so an external <img src="https://iad.microlink.io/..."> ends
 * up as a black box. We fetch each external image, convert it to a
 * base64 data URI, and swap the src. The returned function restores
 * the original srcs.
 *
 * Same-origin and data: URIs are left alone.
 */
async function inlineExternalImages(root: HTMLElement): Promise<() => void> {
  const restores: Array<{ el: HTMLImageElement; original: string }> = [];
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.src;
      if (!src) return;
      // Skip data: URIs (already inline) and same-origin URLs (fine).
      if (src.startsWith("data:")) return;
      try {
        const u = new URL(src, window.location.href);
        if (u.origin === window.location.origin) return;
      } catch {
        return;
      }
      try {
        const res = await fetch(src, { mode: "cors", credentials: "omit" });
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        restores.push({ el: img, original: img.src });
        img.src = dataUrl;
        // Wait for the new src to actually load before we let
        // html2canvas snapshot the DOM.
        await new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve();
          else {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }
        });
      } catch {
        // Network error or CORS rejection — leave the original src in
        // place. The PDF will have a blank square for that image, but
        // the rest of the page still renders.
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

/** Two animation frames to let the browser repaint with all sections
 *  open + print class applied. */
async function waitForRepaint(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

export interface ExportPdfOptions {
  /** Root element to export. Usually the <main> of the report page. */
  target: HTMLElement;
  /** File name (without extension). */
  filename: string;
}

/**
 * Render the target element into a PDF Blob. The PDF is a single tall
 * page sized exactly to the content's natural height, so the visual
 * result is indistinguishable from a long screenshot of the open report.
 */
export async function renderReportToPdf({
  target,
  filename: _filename,
}: ExportPdfOptions): Promise<Blob> {
  const restoreDetails = openAllDetails(target);
  const restorePrinting = markPrinting();
  const restoreAnimations = freezeAnimations();

  let restoreImages: (() => void) | null = null;
  try {
    // First: let the browser repaint the now-open sections.
    await waitForRepaint();
    // Then: swap in data URIs for cross-origin images (Microlink).
    restoreImages = await inlineExternalImages(target);
    // Repaint again so the inlined srcs are committed before capture.
    await waitForRepaint();

    // Capture the target at 3x scale for crisp output. html2canvas is
    // dynamically imported so it doesn't bloat the initial JS bundle.
    const html2canvasModule = await import("html2canvas");
    const html2canvas = (html2canvasModule.default ?? html2canvasModule) as (
      el: HTMLElement,
      opts: Record<string, unknown>,
    ) => Promise<HTMLCanvasElement>;

    const canvas = await html2canvas(target, {
      scale: 3,
      useCORS: true,
      allowTaint: false,
      backgroundColor: "#FCF7F5", // page bg colour
      // Render at the natural width/height so nothing gets squashed.
      width: target.scrollWidth,
      height: target.scrollHeight,
      windowWidth: target.scrollWidth,
      windowHeight: target.scrollHeight,
      // Don't capture native scrollbars / off-screen content beyond
      // the target's bounds.
      scrollX: 0,
      scrollY: -window.scrollY,
      logging: false,
    });

    // Build a SINGLE-PAGE PDF the exact size of the content. Width =
    // the canvas px width / 3 (because scale=3), height = canvas px
    // height / 3. Using "px" units so the PDF page matches what the
    // user sees on screen.
    const jsPdfModule = await import("jspdf");
    type JsPdfConstructor = new (opts: Record<string, unknown>) => JsPdfInstance;
    const JsPDF = (jsPdfModule.jsPDF ?? jsPdfModule.default) as unknown as JsPdfConstructor;

    const pageWidth = canvas.width / 3;
    const pageHeight = canvas.height / 3;
    const pdf = new JsPDF({
      unit: "px",
      format: [pageWidth, pageHeight],
      orientation: pageHeight > pageWidth ? "portrait" : "landscape",
      hotfixes: ["px_scaling"],
      compress: true,
    });

    // Embed the canvas as a JPEG (smaller file than PNG, near-identical
    // visual quality at 0.95).
    const imgData = canvas.toDataURL("image/jpeg", 0.95);
    pdf.addImage(imgData, "JPEG", 0, 0, pageWidth, pageHeight, undefined, "FAST");

    const blob: Blob = pdf.output("blob");
    return blob;
  } finally {
    restoreImages?.();
    restoreDetails();
    restorePrinting();
    restoreAnimations();
  }
}

/** Minimal jsPDF interface — we only use a few methods. */
interface JsPdfInstance {
  addImage: (
    imageData: string,
    format: string,
    x: number,
    y: number,
    w: number,
    h: number,
    alias?: undefined,
    compression?: "NONE" | "FAST" | "MEDIUM" | "SLOW",
  ) => void;
  output: (type: "blob") => Blob;
}

/** Trigger a browser download for the given Blob. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
