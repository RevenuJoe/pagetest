/**
 * Minimal type declarations for the client-side PDF dependencies. The
 * full @types packages exist but they pull in pdfjs-dist and other
 * heavy ambient types that slow tsc to a crawl and create false-
 * positive errors with our existing globals. Since exportReport.ts
 * only uses a tiny surface area of each library, narrow declarations
 * are enough to typecheck and ship.
 */

declare module "html2canvas" {
  interface Html2CanvasOptions {
    scale?: number;
    useCORS?: boolean;
    allowTaint?: boolean;
    backgroundColor?: string | null;
    width?: number;
    height?: number;
    windowWidth?: number;
    windowHeight?: number;
    scrollX?: number;
    scrollY?: number;
    logging?: boolean;
    [key: string]: unknown;
  }

  function html2canvas(
    element: HTMLElement,
    options?: Html2CanvasOptions,
  ): Promise<HTMLCanvasElement>;

  export default html2canvas;
}

declare module "jspdf" {
  interface JsPDFOptions {
    unit?: "pt" | "mm" | "cm" | "in" | "px";
    format?: string | [number, number];
    orientation?: "portrait" | "landscape" | "p" | "l";
    hotfixes?: string[];
    compress?: boolean;
    [key: string]: unknown;
  }

  type CompressionType = "NONE" | "FAST" | "MEDIUM" | "SLOW";

  export class jsPDF {
    constructor(options?: JsPDFOptions);
    addImage(
      imageData: string,
      format: string,
      x: number,
      y: number,
      w: number,
      h: number,
      alias?: undefined,
      compression?: CompressionType,
    ): void;
    output(type: "blob"): Blob;
  }

  const _default: typeof jsPDF;
  export default _default;
}
