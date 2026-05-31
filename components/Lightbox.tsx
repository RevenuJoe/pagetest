/**
 * Reusable click-to-zoom overlay for report screenshots.
 *
 * Two modes:
 * - "atf"      Above-the-fold image (one viewport). Centered, scales to fit
 *              both axes with padding around. No scrolling — the whole
 *              capture is visible at once.
 * - "fullpage" Full scrolled-page capture (very tall). Image fills most of
 *              the viewport width with a small border around it and scrolls
 *              vertically inside the overlay so the user can pan from top
 *              to bottom of the page.
 *
 * Behaviour shared by both modes:
 * - Backdrop is darkened (rgba black 0.78). Clicking the backdrop or
 *   pressing Escape closes the lightbox.
 * - The image itself stops click propagation so clicks inside the image
 *   don't dismiss.
 * - When open, body scroll is locked so the page underneath doesn't move.
 * - Fixed positioning at the viewport root, so it doesn't matter which
 *   section the originating thumbnail lives in — the overlay covers the
 *   whole screen.
 */

"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type LightboxMode = "atf" | "fullpage";

interface LightboxProps {
  open: boolean;
  src: string | null | undefined;
  alt?: string;
  mode: LightboxMode;
  onClose: () => void;
}

export default function Lightbox({
  open,
  src,
  alt = "Screenshot",
  mode,
  onClose,
}: LightboxProps) {
  // Track whether we're mounted in the browser yet — server-side
  // rendering doesn't have a `document` to portal into.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Escape-to-close + body-scroll-lock while the overlay is mounted open.
  // Lock BOTH html and body overflow because some browsers will still
  // scroll the page when only one is pinned, especially if the document
  // root has its own overflow style.
  useEffect(() => {
    if (!open) return;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !src || !mounted) return null;

  // Both modes share the same visual chrome — same backdrop, same close
  // button, same image styling (rounded corners + drop shadow on the
  // image itself, floating directly on the dark backdrop with no
  // inner white frame). The only difference is sizing + scrolling:
  //
  //   atf:      image fits entirely within the viewport. Scaled down
  //             with object-fit:contain so a wide desktop capture and a
  //             portrait mobile capture both look natural.
  //   fullpage: image takes its natural width (capped at 94vw to leave
  //             the dark margin around it) and height runs as tall as
  //             the capture is. The BACKDROP itself becomes the scroll
  //             container, so the user pans the entire overlay vertically
  //             — same UX as the AtF lightbox but with a tall image.
  const isFullPage = mode === "fullpage";

  // Portal-mount the overlay on document.body so it sits OUTSIDE any
  // report-content stacking context. Without the portal, the lightbox
  // is positioned relative to its nearest ancestor that has a
  // transform / filter / will-change / contain rule — which makes it
  // possible for a page-level footer or sticky element to draw on top
  // of it, and which can also clip the overlay short on long pages.
  // Mounting on document.body sidesteps every one of those traps.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        // Very high stacking value. Anything else on the page (the
        // page footer, sticky headers, third-party widgets) sits well
        // below this. Combined with the portal mount on document.body
        // we're outside every report-content stacking context.
        zIndex: 2147483647,
        background: "rgba(0, 0, 0, 0.78)",
        // For atf: flex-center the image. For fullpage: let the backdrop
        // scroll vertically so a tall image can be panned with the native
        // scroll wheel / touch gesture.
        display: isFullPage ? "block" : "flex",
        alignItems: "center",
        justifyContent: "center",
        overflowY: isFullPage ? "auto" : "hidden",
        overflowX: "hidden",
        padding: "4vh 4vw",
        cursor: "zoom-out",
        // Smooth native scrolling on touch devices.
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* Close button (top-right). Stops propagation so it doesn't also
          fire the backdrop-close — though they'd both close the overlay,
          double-handling can race in some browsers. Sticky so it stays
          visible while the user scrolls the fullpage image. */}
      <button
        type="button"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: "fixed",
          top: 16,
          right: 20,
          width: 40,
          height: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 999,
          background: "rgba(255,255,255,0.12)",
          color: "white",
          border: "1px solid rgba(255,255,255,0.25)",
          fontSize: 22,
          lineHeight: 1,
          cursor: "pointer",
          zIndex: 1,
        }}
      >
        ×
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          // Width caps at 94vw for both modes — the visible dark margin
          // around the image is what makes the lightbox feel like a
          // "popup". For atf, additionally cap the height so the image
          // fits in the viewport. For fullpage, no height cap so the
          // image runs as tall as it is and the backdrop scrolls.
          maxWidth: "94vw",
          width: "auto",
          ...(isFullPage
            ? {
                // Center horizontally inside the block-layout backdrop.
                display: "block",
                margin: "0 auto",
                height: "auto",
              }
            : {
                maxHeight: "92vh",
                height: "auto",
                objectFit: "contain",
              }),
          borderRadius: 8,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          cursor: "default",
        }}
      />
    </div>,
    document.body,
  );
}
