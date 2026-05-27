"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Header from "@/components/Header";
import { IconRerun, IconPencil, IconX, Spinner } from "@/components/Icons";
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

  function openReport(r: AnalyzeResponse) {
    // Always navigate to / with the URL — the home page handles both
    // "show saved report" and "show live progress" depending on whether
    // there's an active analysis for that URL.
    router.push(`/?url=${encodeURIComponent(r.url)}`);
  }

  function rerunReport(r: AnalyzeResponse) {
    if (running.has(r.url)) return;
    analysisStore.start(r.url, { preserveName: r.name ?? deriveReportName(r.url) });
  }

  function deleteReport(url: string) {
    savedStore.remove(url);
  }

  function renameReport(url: string, name: string) {
    savedStore.rename(url, name);
  }

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
                  onDelete={() => deleteReport(r.url)}
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
    <li className="flex items-stretch gap-5 rounded-card border border-beige-line bg-card px-5 py-4 shadow-card">
      {/* SCORE column — label on top, circle beneath. Sets the row height. */}
      <div className="flex flex-shrink-0 flex-col items-center gap-1.5">
        <div
          className="text-[10px] font-bold uppercase text-ink-soft"
          style={{ letterSpacing: "0.16em" }}
        >
          Score
        </div>
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full font-bold tabular-nums tracking-tight"
          style={{ background: `${color}1a`, color, fontSize: 22 }}
        >
          {report.overall}
        </div>
      </div>

      {/* Metadata column — Name aligned with the Score label at the top,
          Time of Report aligned with the bottom of the score circle.
          justify-between stretches the three rows evenly across the same
          vertical height. All three values share the same font style; the
          uppercase label is what distinguishes them. */}
      <div className="flex min-w-0 flex-1 flex-col justify-between">
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
              className="w-full rounded-md border border-accent bg-card px-2 py-0.5 text-[14px] font-semibold tracking-tight text-ink outline-none focus:ring-4 focus:ring-accent-soft"
            />
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpen}
                className="min-w-0 max-w-full truncate text-left text-[14px] font-semibold tracking-tight text-ink hover:text-accent"
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
                <IconPencil />
              </button>
            </div>
          )}
        </LabelledRow>

        <LabelledRow label="URL">
          <a
            href={report.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block min-w-0 truncate text-[14px] font-semibold tracking-tight text-ink hover:text-accent"
            title={report.url}
          >
            {report.url}
          </a>
        </LabelledRow>

        <LabelledRow label="Time of Report">
          <span className="text-[14px] font-semibold tracking-tight text-ink">
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

      {/* Actions column — Open above Rerun, both same width. Delete is a
          small × tucked beneath. The whole column centres vertically inside
          the row so it sits next to the score chip. */}
      <div className="flex flex-shrink-0 flex-col items-stretch justify-center gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="w-24 rounded-full border border-beige-line bg-card px-3.5 py-1.5 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
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
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove this saved report"
          title="Delete"
          className="mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-ink-soft transition hover:bg-bg hover:text-bad"
        >
          <IconX />
        </button>
      </div>
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
    <div className="flex items-baseline gap-2 min-w-0">
      <span
        className="flex-shrink-0 text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}:
      </span>
      <div className="min-w-0 flex-1 truncate">{children}</div>
    </div>
  );
}
