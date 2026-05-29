"use client";

/**
 * Modal shown while a report PDF is being generated and after it's
 * ready. Two visual states:
 *
 *   "preparing" — spinner + "Preparing Your Download…" + sub-line
 *   "ready"     — animated tick + thumbs-up fox + "Great, your download
 *                 is ready" + sub-line + download button
 *
 * Backdrop dims the page; clicking outside the card does NOT close while
 * preparing (so the user can't accidentally cancel a render). On ready
 * state, clicking the backdrop or the close button dismisses the modal.
 */

import { useEffect } from "react";
import { Spinner } from "@/components/Icons";

export type DownloadState = "preparing" | "ready" | "error";

export default function DownloadModal({
  state,
  onClose,
  onDownload,
  errorMessage,
}: {
  state: DownloadState;
  onClose: () => void;
  /** Called when the user clicks the "Download report" button on the
   *  ready state. The blob URL is already prepared by the parent — this
   *  just triggers the actual file download. */
  onDownload: () => void;
  errorMessage?: string;
}) {
  // Esc to close, but only when the modal isn't actively preparing.
  useEffect(() => {
    if (state === "preparing") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  return (
    <div
      aria-modal="true"
      role="dialog"
      className="fixed inset-0 z-50 flex items-center justify-center px-6 animate-[fadeIn_240ms_ease-out]"
    >
      {/* Dim backdrop. While preparing, clicks are absorbed (no close);
          on ready/error, clicking outside the card dismisses. */}
      <div
        className="absolute inset-0 bg-ink/45 backdrop-blur-[1.5px]"
        onClick={state === "preparing" ? undefined : onClose}
        aria-hidden
      />

      <div
        className="relative z-10 w-full max-w-[460px] rounded-card border border-beige-line bg-card p-8 shadow-card"
        style={{
          // Soft entrance animation specific to the card.
          animation: "fadeIn 320ms ease-out",
        }}
      >
        {state === "preparing" && <PreparingState />}
        {state === "ready" && <ReadyState onDownload={onDownload} onClose={onClose} />}
        {state === "error" && (
          <ErrorState message={errorMessage ?? ""} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function PreparingState() {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-dark">
        <Spinner className="h-6 w-6" />
      </span>
      <p className="mt-5 text-[18px] font-bold tracking-tight text-ink">
        Preparing Your Download
      </p>
      <p className="mt-2 text-[13px] font-medium leading-[1.55] text-ink-soft">
        Bundling the full report into a PDF. This usually takes 10 to 20 seconds.
      </p>
    </div>
  );
}

function ReadyState({
  onDownload,
  onClose,
}: {
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-accent-dark">
        <AnimatedTick />
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/fox-thumbs-up.webp"
        alt=""
        aria-hidden
        className="mt-4 h-[110px] w-auto select-none"
      />
      <p className="mt-4 text-[18px] font-bold tracking-tight text-ink">
        Great, your download is ready.
      </p>
      <p className="mt-1 text-[13px] font-medium text-ink-soft">
        Save the PDF to keep a copy of this report.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-beige-line bg-card px-4 py-2 text-[13px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-dark"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden
          >
            <path d="M12 3v12" />
            <path d="M7 10l5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          Download report
        </button>
      </div>
    </div>
  );
}

function ErrorState({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: "#fbece9", color: "#b25148" }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
          aria-hidden
        >
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </span>
      <p className="mt-5 text-[18px] font-bold tracking-tight text-ink">
        Couldn&apos;t prepare the download
      </p>
      <p className="mt-2 max-w-[340px] text-[13px] font-medium leading-[1.55] text-ink-soft">
        {message || "Something went wrong while creating the PDF. Try again in a moment."}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-5 rounded-full border border-beige-line bg-card px-5 py-2 text-[13px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
      >
        Close
      </button>
    </div>
  );
}

/** The same animated tick used on the home page "Report ready"
 *  celebration. Copied here so this component is self-contained. */
function AnimatedTick() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-7 w-7"
      aria-hidden
    >
      <path
        d="M5 12l5 5L20 7"
        style={{
          strokeDasharray: 30,
          strokeDashoffset: 30,
          animation: "tickDraw 480ms ease-out forwards",
        }}
      />
    </svg>
  );
}
