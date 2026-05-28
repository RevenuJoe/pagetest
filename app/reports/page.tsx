"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Header from "@/components/Header";
import Section from "@/components/Section";
import { OverviewBlock } from "@/components/Results";
import { IconRerun, IconTrash } from "@/components/Icons";
import { useRunningUrls, useSavedReports } from "@/lib/storeHooks";
import { analysisStore } from "@/lib/analysisStore";
import { savedStore } from "@/lib/savedStore";
import { deriveReportName, displayName } from "@/lib/nameUtil";
import type { AnalyzeResponse } from "@/lib/types";

export default function ReportsPage() {
  const reports = useSavedReports();
  const running = useRunningUrls();
  const router = useRouter();
  // URL of the report the user has clicked the trash icon for. When set,
  // we open the branded confirmation modal — only after the user confirms
  // do we actually remove the report from savedStore.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  function openReport(r: AnalyzeResponse) {
    // /report is the dedicated viewer for saved reports — same canonical
    // URL for every report, with the report's URL passed in the query so
    // the page can look it up from savedStore.
    router.push(`/report?url=${encodeURIComponent(r.url)}`);
  }

  function rerunReport(r: AnalyzeResponse) {
    if (running.has(r.url)) return;
    analysisStore.start(r.url, { preserveName: r.name ?? deriveReportName(r.url) });
  }

  function confirmDelete() {
    if (confirmingDelete) savedStore.remove(confirmingDelete);
    setConfirmingDelete(null);
  }

  // Pre-compute the report being confirmed so the modal can display its name.
  const confirmingReport = confirmingDelete
    ? reports.find((r) => r.url === confirmingDelete)
    : undefined;

  return (
    <div className="min-h-screen">
      <Header active />

      <main className="mx-auto max-w-[1180px] px-6 pb-24 sm:px-14">
        <section className="pt-14 md:pt-20">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-[clamp(28px,4vw,44px)] font-bold leading-[1.04] tracking-tight text-ink">
              Your saved reports
            </h1>
            <Link
              href="/"
              className="text-[13px] font-semibold text-ink-soft hover:text-ink"
            >
              ← Run a new analysis
            </Link>
          </div>
          <p className="mt-2 max-w-[640px] text-[14px] font-medium leading-[1.6] text-ink-soft">
            Every page test you run is auto-saved here. Click a card to
            expand the report preview, hit Open to view the full report, or
            Rerun to refresh the scores.
          </p>
        </section>

        <section className="mt-10">
          {reports.length === 0 ? (
            <div className="rounded-[24px] border border-beige-line bg-card p-10 text-center shadow-card">
              <p className="text-sm font-medium text-ink-soft">
                You haven&apos;t run a report yet.
              </p>
              <Link
                href="/"
                className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-dark"
              >
                Run your first report
              </Link>
            </div>
          ) : (
            <ul className="m-0 flex flex-col gap-2.5 p-0 list-none">
              {reports.map((r) => (
                <ReportRow
                  key={r.url}
                  report={r}
                  running={running.has(r.url)}
                  onOpen={() => openReport(r)}
                  onRerun={() => rerunReport(r)}
                  onDelete={() => setConfirmingDelete(r.url)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="mt-20 border-t border-beige-line bg-bg py-9 text-center text-[14px] text-ink-soft">
        <div className="mx-auto max-w-[1180px] px-6 sm:px-14">
          <p className="m-0">© Revenu</p>
        </div>
      </footer>

      {confirmingDelete && (
        <ConfirmDeleteModal
          name={confirmingReport ? displayName(confirmingReport) : undefined}
          onCancel={() => setConfirmingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

/**
 * Branded confirmation modal shown when the user clicks the trash icon on a
 * saved report. Dimmed page underlay, cream card with rounded corners, a
 * clear question, optional report name for context, and two actions —
 * Cancel (outline) and Delete (filled red). Closes on backdrop click, Esc
 * key, or either action.
 */
function ConfirmDeleteModal({
  name,
  onCancel,
  onConfirm,
}: {
  name?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]"
      />
      {/* Card */}
      <div className="relative w-full max-w-[420px] rounded-[20px] border border-beige-line bg-card p-7 shadow-cardHover">
        <h2
          id="confirm-delete-title"
          className="m-0 text-[18px] font-bold tracking-tight text-ink"
        >
          Delete this report?
        </h2>
        <p className="mt-2 text-[14px] font-medium leading-[1.6] text-ink-soft">
          {name
            ? `"${name}" will be removed from your saved reports. This cannot be undone.`
            : "This report will be removed from your saved reports. This cannot be undone."}
        </p>
        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-beige-line bg-card px-5 py-2 text-[13px] font-semibold text-ink-soft transition hover:border-ink hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className="rounded-full bg-bad px-5 py-2 text-[13px] font-semibold text-white transition hover:opacity-90"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One saved-report card. It IS the Overview section from the report view —
 * same collapsible Section component, same OverviewBlock content. The
 * section title is the report's display name. Header carries Open and
 * Rerun buttons that don't toggle the section. Trash icon hangs outside
 * the card's right edge.
 */
function ReportRow({
  report,
  running,
  onOpen,
  onRerun,
  onDelete,
}: {
  report: AnalyzeResponse;
  running: boolean;
  onOpen: () => void;
  onRerun: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="relative">
      <Section
        title={displayName(report)}
        defaultOpen={false}
        headerAction={
          <HeaderActions
            running={running}
            onOpen={onOpen}
            onRerun={onRerun}
          />
        }
      >
        <OverviewBlock data={report} />
      </Section>

      {/* Trash icon — hangs outside the card on the right, no background. */}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete this saved report"
        title="Delete"
        className="absolute right-[-32px] top-[33px] flex h-7 w-7 items-center justify-center bg-transparent text-ink-soft transition hover:text-bad"
      >
        <IconTrash />
      </button>
    </li>
  );
}

/**
 * Buttons rendered inside a saved-report Section header. Clicks call the
 * handlers without toggling the surrounding <details> — preventDefault +
 * stopPropagation on the button click is what blocks the native toggle.
 */
function HeaderActions({
  running,
  onOpen,
  onRerun,
}: {
  running: boolean;
  onOpen: () => void;
  onRerun: () => void;
}) {
  function stop(handler: () => void) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    };
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={stop(onOpen)}
        className="rounded-full border border-beige-line bg-card px-4 py-1.5 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
      >
        Open
      </button>
      <button
        type="button"
        onClick={stop(onRerun)}
        disabled={running}
        className="inline-flex items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        <IconRerun />
        {running ? "Running…" : "Rerun"}
      </button>
    </div>
  );
}
