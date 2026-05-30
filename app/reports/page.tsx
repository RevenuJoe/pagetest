"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Header from "@/components/Header";
import Section from "@/components/Section";
import { OverviewBlock } from "@/components/Results";
import { IconRerun, IconTrash, IconPencil } from "@/components/Icons";
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
  // URL of the report being renamed. When set, the rename modal opens.
  const [renamingUrl, setRenamingUrl] = useState<string | null>(null);

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

  function saveRename(newName: string) {
    if (renamingUrl) savedStore.rename(renamingUrl, newName);
    setRenamingUrl(null);
  }

  // Pre-compute the report being confirmed so the modal can display its name.
  const confirmingReport = confirmingDelete
    ? reports.find((r) => r.url === confirmingDelete)
    : undefined;
  const renamingReport = renamingUrl
    ? reports.find((r) => r.url === renamingUrl)
    : undefined;

  return (
    <div className="min-h-screen">
      <Header active />

      <main className="mx-auto max-w-[1180px] px-6 pb-24 sm:px-14">
        <section className="pt-14 md:pt-20">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-[clamp(14px,2vw,22px)] font-bold leading-[1.04] tracking-tight text-ink">
              Your Saved Websites
            </h1>
            <Link
              href="/"
              className="whitespace-nowrap text-[13px] font-semibold text-ink-soft hover:text-ink"
            >
              ← Run a new analysis
            </Link>
          </div>
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
                  onEdit={() => setRenamingUrl(r.url)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="mt-5 border-t border-beige-line bg-bg py-9 text-center text-[14px] text-ink-soft">
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

      {renamingUrl && (
        <RenameModal
          initial={renamingReport ? displayName(renamingReport) : ""}
          onCancel={() => setRenamingUrl(null)}
          onSave={saveRename}
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
            ? `"${name}" will be removed from your saved websites. This cannot be undone.`
            : "This report will be removed from your saved websites. This cannot be undone."}
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
  onEdit,
}: {
  report: AnalyzeResponse;
  running: boolean;
  onOpen: () => void;
  onRerun: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  return (
    <li className="relative">
      <Section
        title={displayName(report)}
        defaultOpen={false}
        compact
        headerAction={
          <HeaderActions
            running={running}
            onOpen={onOpen}
            onRerun={onRerun}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        }
      >
        <OverviewBlock data={report} />
      </Section>

      {/* DESKTOP trash icon. Hangs OUTSIDE the card to the right, keeping
          the card's internal layout clean. Hidden on mobile (the trash
          icon is rendered INSIDE HeaderActions on mobile so the three
          icons sit in one evenly-spaced row). */}
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete this saved report"
        title="Delete"
        className="absolute right-[-32px] top-[19px] z-10 hidden h-7 w-7 items-center justify-center bg-transparent text-ink-soft transition hover:text-bad sm:flex"
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
  onEdit,
  onDelete,
}: {
  running: boolean;
  onOpen: () => void;
  onRerun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  function stop(handler: () => void) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    };
  }
  // Mobile gap tightened to gap-2 (8px, ~30% less than the previous
  // gap-3 = 12px) so the three icon buttons sit closer together near
  // the right edge. Desktop keeps the same gap-2.
  return (
    <div className="flex items-center gap-2">
      {/* Rename pencil — hidden on mobile to give the title more room.
          Users can still rename by opening the report and editing there. */}
      <button
        type="button"
        onClick={stop(onEdit)}
        aria-label="Rename this report"
        title="Rename"
        className="hidden h-7 w-7 items-center justify-center rounded-full text-ink-soft transition hover:bg-bg hover:text-accent sm:flex"
      >
        <IconPencil className="h-[14px] w-[14px]" />
      </button>
      {/* Open button. Desktop shows the "Open" pill; mobile compresses
          to a small arrow-only icon so all three actions fit. */}
      <button
        type="button"
        onClick={stop(onOpen)}
        aria-label="Open this report"
        title="Open"
        className="hidden rounded-full border border-beige-line bg-card px-4 py-1.5 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent sm:inline-block"
      >
        Open
      </button>
      <button
        type="button"
        onClick={stop(onOpen)}
        aria-label="Open this report"
        title="Open"
        className="flex h-7 w-7 items-center justify-center rounded-full border border-beige-line bg-card text-ink-soft transition hover:border-accent hover:text-accent sm:hidden"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      {/* Rerun. Mobile: icon only, h-7 w-7 to match the other icon
          buttons. Desktop: icon + label pill. */}
      <button
        type="button"
        onClick={stop(onRerun)}
        disabled={running}
        aria-label={running ? "Running…" : "Rerun this report"}
        title={running ? "Running…" : "Rerun"}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-60 sm:hidden"
      >
        <IconRerun />
      </button>
      <button
        type="button"
        onClick={stop(onRerun)}
        disabled={running}
        aria-label={running ? "Running…" : "Rerun this report"}
        title={running ? "Running…" : "Rerun"}
        className="hidden items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-60 sm:inline-flex"
      >
        <IconRerun />
        {running ? "Running…" : "Rerun"}
      </button>
      {/* MOBILE trash button. Sits in the same flex row as Open + Rerun
          so the three are evenly spaced. Desktop renders the trash
          icon outside the card (handled in ReportRow). */}
      <button
        type="button"
        onClick={stop(onDelete)}
        aria-label="Delete this saved report"
        title="Delete"
        className="flex h-7 w-7 items-center justify-center bg-transparent text-ink-soft transition hover:text-bad sm:hidden"
      >
        <IconTrash />
      </button>
    </div>
  );
}

/**
 * Branded modal for renaming a saved report. Mirrors the confirm-delete
 * modal styling (cream card, dim backdrop, Cancel + Save buttons).
 */
function RenameModal({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length > 0) onSave(trimmed);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]"
      />
      <form
        onSubmit={submit}
        className="relative w-full max-w-[440px] rounded-[20px] border border-beige-line bg-card p-7 shadow-cardHover"
      >
        <h2 id="rename-title" className="m-0 text-[18px] font-bold tracking-tight text-ink">
          Rename report
        </h2>
        <p className="mt-2 text-[14px] font-medium leading-[1.6] text-ink-soft">
          Choose a name you&apos;ll recognise on the Saved Websites list.
        </p>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-5 w-full rounded-[10px] border border-beige-line bg-card px-3.5 py-2.5 text-[14px] font-semibold tracking-tight text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent-soft"
          aria-label="New report name"
        />
        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-beige-line bg-card px-5 py-2 text-[13px] font-semibold text-ink-soft transition hover:border-ink hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={value.trim().length === 0}
            className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
