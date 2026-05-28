"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Header from "@/components/Header";
import { IconRerun, IconPencil, IconTrash, Spinner } from "@/components/Icons";
import { useRunningUrls, useSavedReports } from "@/lib/storeHooks";
import { analysisStore } from "@/lib/analysisStore";
import { savedStore } from "@/lib/savedStore";
import { scoreColor } from "@/lib/scoreColor";
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

  function renameReport(url: string, name: string) {
    savedStore.rename(url, name);
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
            Every page test you run is auto-saved here. Click a report to open
            it, rerun to refresh the scores, or rename it to something more
            memorable.
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
                  onRename={(name) => renameReport(r.url, name)}
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

function ReportRow({
  report,
  running,
  onOpen,
  onRerun,
  onRename,
  onDelete,
}: {
  report: AnalyzeResponse;
  running: boolean;
  onOpen: () => void;
  onRerun: () => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
}) {
  const color = scoreColor(report.overall);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName(report));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(displayName(report));
  }, [report.name, report.url, editing]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== (report.name ?? "")) onRename(trimmed);
    setEditing(false);
  }

  return (
    <li className="relative flex items-start gap-7 rounded-card border border-beige-line bg-card px-7 py-5 shadow-card">
      {/* SCORE column — proportions match the reference screenshot: small
          uppercase label, ~52px circle below it. */}
      <div className="flex flex-shrink-0 flex-col items-center gap-2 mt-1">
        <div
          className="text-[11px] font-bold uppercase text-ink-soft"
          style={{ letterSpacing: "0.18em" }}
        >
          Score
        </div>
        <div
          className="flex items-center justify-center rounded-full font-bold tabular-nums tracking-tight"
          style={{
            background: `${color}1a`,
            color,
            fontSize: 20,
            width: 52,
            height: 52,
          }}
        >
          {report.overall}
        </div>
      </div>

      {/* Metadata column — three rows, each with the label stacked above
          its value. Matches the Overview MetaRow styling Joe asked for. */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 mt-[2px]">
        <LabelledRow label="Name">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(displayName(report));
                  setEditing(false);
                }
              }}
              className="w-full rounded-md border border-accent bg-card px-2 py-0.5 text-[15px] font-semibold tracking-tight text-ink outline-none focus:ring-4 focus:ring-accent-soft"
            />
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpen}
                className="min-w-0 max-w-full truncate text-left text-[15px] font-semibold tracking-tight text-ink hover:text-accent"
                title={report.url}
              >
                {displayName(report)}
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label="Rename this report"
                title="Rename"
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-bg hover:text-accent"
              >
                <IconPencil className="h-[14px] w-[14px]" />
              </button>
            </div>
          )}
        </LabelledRow>

        <LabelledRow label="URL">
          <a
            href={report.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block min-w-0 break-all text-[15px] font-semibold tracking-tight text-ink hover:text-accent"
            title={report.url}
          >
            {report.url}
          </a>
        </LabelledRow>

        <LabelledRow label="Time of Report">
          <span className="text-[15px] font-semibold tracking-tight text-ink">
            {new Date(report.analyzedAt).toLocaleString()}
          </span>
          {running && (
            <span className="ml-2 inline-flex items-center gap-1 text-[12px] font-semibold text-accent">
              <Spinner className="h-3 w-3" />
              Rerunning…
            </span>
          )}
        </LabelledRow>
      </div>

      {/* Actions column — Open + Rerun stacked, button content centred. */}
      <div className="flex flex-shrink-0 flex-col items-stretch justify-center gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="w-24 rounded-full border border-beige-line bg-card px-3.5 py-1.5 text-center text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onRerun}
          disabled={running}
          className="inline-flex w-24 items-center justify-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          <IconRerun />
          {running ? "Running…" : "Rerun"}
        </button>
      </div>

      {/* Trash icon — sits OUTSIDE the card's right edge with no background,
          just a small transparent ink-soft icon that turns red on hover.
          Absolutely positioned against the relative <li> parent. */}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete this saved report"
        title="Delete"
        className="absolute right-[-32px] top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center bg-transparent text-ink-soft transition hover:text-bad"
      >
        <IconTrash />
      </button>
    </li>
  );
}

/**
 * One labelled metadata row inside a saved-report card.
 *
 * The label is small caps in the muted ink-soft colour. The value owns its
 * own styling (passed as children) so the three rows visually share the
 * same font, weight and colour even though their content is different.
 */
function LabelledRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div
        className="text-[11px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        {label}
      </div>
      <div className="mt-3 min-w-0 text-[15px] font-semibold tracking-tight text-ink break-words">
        {children}
      </div>
    </div>
  );
}
