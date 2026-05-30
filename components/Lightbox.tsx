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

import { useEffect } from "react";

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
  // Escape-to-close + body-scroll-lock while the overlay is mounted open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !src) return null;

  // Layout differs per mode.
  // - atf:      flex-center, image max-h:90vh max-w:92vw, object-contain.
  // - fullpage: scroll container fills 96vw x 94vh with a small border;
  //             image is width:100% height:auto inside it; container
  //             scrolls vertically.
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.78)",
        display: "flex",
        alignItems: mode === "fullpage" ? "flex-start" : "center",
        justifyContent: "center",
        padding: mode === "fullpage" ? "3vh 2vw" : "4vh 4vw",
        cursor: "zoom-out",
      }}
    >
      {/* Close button (top-right). Stops propagation so it doesn't also
          fire the backdrop-close — though they'd both close the overlay,
          double-handling can race in some browsers. */}
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

      {mode === "atf" ? (
        // ATF: centered, no scrolling, fits within viewport.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          onClick={(e) => e.stopPropagation()}
          style={{
            maxHeight: "92vh",
            maxWidth: "94vw",
            width: "auto",
            height: "auto",
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
            cursor: "default",
          }}
        />
      ) : (
        // FULL PAGE: scrollable inner container so very tall captures can
        // be panned top-to-bottom. Width fills most of viewport with a
        // visible margin so the overlay frame is obviously a "popup".
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "min(96vw, 1400px)",
            maxHeight: "94vh",
            overflowY: "auto",
            overflowX: "hidden",
            background: "white",
            borderRadius: 10,
            boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
            border: "1px solid rgba(255,255,255,0.2)",
            cursor: "default",
            // Smooth native scrolling on touch devices.
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
            }}
          />
        </div>
      )}
    </div>
  );
}
