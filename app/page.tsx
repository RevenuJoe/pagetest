"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzeResponse, CheckKey, CheckResult } from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";
import ScoreCard from "@/components/ScoreCard";
import { scoreColor } from "@/lib/scoreColor";

const LOADING_STEPS = [
  "Booting Lighthouse on Google's servers…",
  "Measuring Largest Contentful Paint…",
  "Capturing desktop above-the-fold…",
  "Running the mobile audit…",
  "Reading the page content…",
  "Asking Claude to grade the page…",
  "Compiling your report…",
];

const SAVED_KEY = "pagetest-saved-reports-v1";
const MAX_SAVED = 15;

// ---------- localStorage helpers for saved reports ----------
function loadSavedReports(): AnalyzeResponse[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnalyzeResponse[]) : [];
  } catch {
    return [];
  }
}

function persistSavedReports(reports: AnalyzeResponse[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(reports));
  } catch {
    // Likely a quota error — silently drop. Reports stay in memory.
  }
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [saved, setSaved] = useState<AnalyzeResponse[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  // URLs that are currently being rerun in the background (from the saved-
  // reports panel). The row for each shows a "Running…" indicator instead
  // of the Rerun button while the analysis is in flight.
  const [backgroundRunning, setBackgroundRunning] = useState<Set<string>>(
    () => new Set(),
  );
  const resultsRef = useRef<HTMLDivElement>(null);

  // Load saved reports from localStorage once on mount.
  useEffect(() => {
    setSaved(loadSavedReports());
  }, []);

  // Drive the loading-step progress text on a timer while a run is active.
  useEffect(() => {
    if (!loading) return;
    setStepIndex(0);
    const id = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, LOADING_STEPS.length - 1));
    }, 6000);
    return () => clearInterval(id);
  }, [loading]);

  // Whenever a result lands, smooth-scroll the report into view.
  useEffect(() => {
    if (result && resultsRef.current) {
      resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

  const runAnalysis = useCallback(
    async (targetUrl: string) => {
      if (!targetUrl.trim() || loading) return;
      setError(null);
      setResult(null);
      setSavedOpen(false);
      setLoading(true);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error || "Something went wrong. Please try again.");
          return;
        }
        const report = body as AnalyzeResponse;
        setResult(report);
        setSaved((prev) => {
          // Drop any older entry for the same URL so the list shows just
          // the latest run per URL, then prepend and cap.
          const deduped = prev.filter((r) => r.url !== report.url);
          const next = [report, ...deduped].slice(0, MAX_SAVED);
          persistSavedReports(next);
          return next;
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Network error. Please try again.",
        );
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    runAnalysis(url);
  }

  function openSavedReport(report: AnalyzeResponse) {
    setSavedOpen(false);
    setError(null);
    setResult(report);
    setUrl(report.url);
  }

  function rerunReport(report: AnalyzeResponse) {
    setUrl(report.url);
    setSavedOpen(false);
    runAnalysis(report.url);
  }

  // Background rerun: kicks off the analyze call without navigating away
  // from the saved-reports panel. When it completes, the row updates in
  // place with the fresh score (preserving any user-set name).
  const rerunInBackground = useCallback(
    async (report: AnalyzeResponse) => {
      const targetUrl = report.url;
      if (backgroundRunning.has(targetUrl)) return;
      setBackgroundRunning((prev) => {
        const next = new Set(prev);
        next.add(targetUrl);
        return next;
      });
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error || "Rerun failed for " + targetUrl);
          return;
        }
        const fresh = body as AnalyzeResponse;
        // Preserve the user-set name across reruns.
        if (report.name) fresh.name = report.name;
        setSaved((prev) => {
          const next = prev.map((r) => (r.url === targetUrl ? fresh : r));
          persistSavedReports(next);
          return next;
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? "Rerun failed: " + err.message
            : "Rerun failed.",
        );
      } finally {
        setBackgroundRunning((prev) => {
          const next = new Set(prev);
          next.delete(targetUrl);
          return next;
        });
      }
    },
    [backgroundRunning],
  );

  function renameSavedReport(targetUrl: string, newName: string) {
    const trimmed = newName.trim();
    setSaved((prev) => {
      const next = prev.map((r) =>
        r.url === targetUrl
          ? { ...r, name: trimmed.length > 0 ? trimmed : undefined }
          : r,
      );
      persistSavedReports(next);
      return next;
    });
  }

  function deleteSavedReport(targetUrl: string) {
    setSaved((prev) => {
      const next = prev.filter((r) => r.url !== targetUrl);
      persistSavedReports(next);
      return next;
    });
  }

  return (
    <div className="min-h-screen">
      <Header
        savedCount={saved.length}
        savedOpen={savedOpen}
        onToggleSaved={() => setSavedOpen((v) => !v)}
      />

      <main className="mx-auto max-w-[1180px] px-6 pb-24 sm:px-14">
        <section className="pt-14 md:pt-20">
          <div className="text-center">
            <h1 className="text-[clamp(32px,4.7vw,54px)] font-bold leading-[1.04] tracking-tight text-ink">
              Score any landing page in{" "}
              <span style={{ color: "#76A09C" }}>60 seconds.</span>
            </h1>
            <ul className="mx-auto mt-7 flex flex-wrap items-center justify-center gap-2.5 p-0 list-none">
              {(
                [
                  [
                    "Enter your landing page URL",
                    <svg
                      key="ico"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3 w-3"
                      aria-hidden
                    >
                      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
                      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
                    </svg>,
                  ],
                  [
                    "We'll check its speed with Google Page Insights",
                    <svg
                      key="ico"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="none"
                      className="h-3 w-3"
                      aria-hidden
                    >
                      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
                    </svg>,
                  ],
                  [
                    "We'll analyse its content with Claude",
                    <svg
                      key="ico"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="none"
                      className="h-3 w-3"
                      aria-hidden
                    >
                      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
                    </svg>,
                  ],
                ] as const
              ).map(([label, icon]) => (
                <li
                  key={label}
                  className="inline-flex items-center gap-2 rounded-full border border-beige-line bg-card py-1 pl-1 pr-3.5 text-[12px] font-medium text-ink"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent-dark">
                    {icon}
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          </div>

          <form
            onSubmit={onSubmit}
            className="mx-auto mt-9 flex w-full max-w-[640px] flex-col items-stretch gap-2.5 sm:flex-row"
          >
            <div className="relative flex-1">
              <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-ink-soft">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-5 w-5"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
                </svg>
              </span>
              <input
                type="text"
                inputMode="url"
                placeholder="https://yoursite.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                className="w-full rounded-[14px] border border-beige-line bg-card py-4 pl-12 pr-4 text-[15px] font-medium text-ink outline-none transition placeholder:font-medium placeholder:text-[#98a0a4] focus:border-accent focus:ring-4 focus:ring-accent-soft disabled:opacity-60"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-[14px] bg-accent px-6 py-4 text-sm font-semibold tracking-[0.01em] text-white transition hover:bg-accent-dark active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {loading ? (
                <>
                  <Spinner />
                  Analysing…
                </>
              ) : (
                <>
                  Run analysis
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                    aria-hidden
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </>
              )}
            </button>
          </form>

          {error && (
            <div className="mx-auto mt-[18px] max-w-[640px] rounded-[14px] border border-[#f1c9c5] bg-[#fbece9] px-4 py-3.5 text-sm font-medium text-bad">
              {error}
            </div>
          )}

          {loading && (
            <div className="mx-auto mt-9 max-w-[640px]">
              <div className="rounded-card border border-beige-line bg-card p-[22px] shadow-card">
                <div className="flex items-center gap-3">
                  <Spinner className="text-accent" />
                  <p className="text-sm font-semibold text-ink">
                    {LOADING_STEPS[stepIndex]}
                  </p>
                </div>
                <div className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-beige-line">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-[800ms] ease-out"
                    style={{
                      width: `${((stepIndex + 1) / LOADING_STEPS.length) * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-3 text-xs font-medium text-ink-soft">
                  This usually takes 30–60 seconds — Lighthouse is doing a full
                  real-world render of the page.
                </p>
              </div>
            </div>
          )}
        </section>

        {savedOpen && (
          <section className="mt-16">
            <SavedReportsPanel
              reports={saved}
              backgroundRunning={backgroundRunning}
              onOpen={openSavedReport}
              onRerun={rerunInBackground}
              onRename={renameSavedReport}
              onDelete={deleteSavedReport}
              onClose={() => setSavedOpen(false)}
            />
          </section>
        )}

        {result && !savedOpen && (
          <section ref={resultsRef} className="mt-16 scroll-mt-12">
            <Results data={result} onRerun={() => rerunReport(result)} />
          </section>
        )}

        {!loading && !result && !savedOpen && (
          <section className="mt-[72px]">
            <FeaturesGrid />
          </section>
        )}
      </main>

      {/* Matches .site-footer on library.revenuagency.io exactly */}
      <footer className="mt-20 border-t border-beige-line bg-bg py-9 text-center text-[14px] text-ink-soft">
        <div className="mx-auto max-w-[1180px] px-6 sm:px-14">
          <p className="m-0">© Revenu</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Header ---------- */
function Header({
  savedCount,
  savedOpen,
  onToggleSaved,
}: {
  savedCount: number;
  savedOpen: boolean;
  onToggleSaved: () => void;
}) {
  return (
    <header className="px-6 py-5 sm:px-14">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-6">
        <a
          href="https://www.revenuagency.io"
          className="text-[clamp(18px,1.6vw,24px)] font-semibold text-ink"
          style={{ letterSpacing: "0.24em", lineHeight: 1 }}
        >
          REVENU
        </a>
        <div className="flex items-center gap-4">
          <a
            href="https://www.revenuagency.io"
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-ink-soft hover:text-ink"
          >
            revenuagency.io ↗
          </a>
          <button
            type="button"
            onClick={onToggleSaved}
            aria-label={
              savedCount > 0
                ? `Your saved reports (${savedCount})`
                : "Your saved reports"
            }
            title="Your saved reports"
            className={`relative flex h-9 w-9 items-center justify-center rounded-full border transition ${
              savedOpen
                ? "border-accent bg-accent text-white"
                : "border-beige-line bg-card text-ink-soft hover:text-ink"
            }`}
          >
            <IconReport />
            {savedCount > 0 && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg"
                style={{ background: "#22c55e" }}
              />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-[18px] w-[18px] animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ---------- Collapsible section ---------- */
function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-[24px] border border-beige-line bg-card shadow-card overflow-hidden"
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between px-7 py-5"
        style={{ outline: "none" }}
      >
        <h2
          className="m-0 text-[12px] font-bold uppercase text-ink-soft"
          style={{ letterSpacing: "0.18em" }}
        >
          {title}
        </h2>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 text-ink-soft transition-transform group-open:rotate-180"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div className="border-t border-beige-line px-7 py-7">{children}</div>
    </details>
  );
}

/* ---------- Results (four collapsible sections) ---------- */
function Results({
  data,
  onRerun,
}: {
  data: AnalyzeResponse;
  onRerun: () => void;
}) {
  return (
    <div className="space-y-5">
      <Section title="The Overview">
        <OverviewBlock data={data} onRerun={onRerun} />
      </Section>
      <Section title="Breakdown">
        <BreakdownBlock data={data} />
      </Section>
      <Section title="Key Takeaways">
        <KeyTakeawaysBlock data={data} />
      </Section>
      <Section title="Initial Load Screenshots">
        <ScreenshotsBlock data={data} />
      </Section>
    </div>
  );
}

const CHECK_META: Record<
  CheckKey,
  { title: string; icon: React.ReactNode }
> = {
  speed: { title: "Speed", icon: <IconBolt /> },
  content: { title: "Content", icon: <IconText /> },
  digestibility: { title: "Digestibility", icon: <IconLayers /> },
  cro: { title: "CRO", icon: <IconTarget /> },
  aboveTheFold: { title: "Above the fold", icon: <IconEye /> },
  mobile: { title: "Mobile layout", icon: <IconPhone /> },
};

function OverviewBlock({
  data,
  onRerun,
}: {
  data: AnalyzeResponse;
  onRerun: () => void;
}) {
  const order: CheckKey[] = [
    "speed",
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  return (
    <div>
      <div className="flex flex-col items-center gap-8 md:flex-row md:items-center md:gap-10">
        <ScoreRing score={data.overall} size={160} label="OVERALL" />
        <div className="flex-1 text-center md:text-left">
          <p
            className="text-[11px] font-bold uppercase text-ink-soft"
            style={{ letterSpacing: "0.16em" }}
          >
            REPORT FOR
          </p>
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1.5 inline-block break-all text-[18px] font-bold tracking-tight text-ink hover:text-accent"
          >
            {data.url}
          </a>
          <p className="mt-1.5 text-[13px] font-medium text-ink-soft">
            Analysed {new Date(data.analyzedAt).toLocaleString()}
          </p>
          <p className="mt-3.5 max-w-[540px] text-sm font-medium leading-[1.65] text-ink">
            {overallSummary(data.overall)}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center">
          <button
            type="button"
            onClick={onRerun}
            className="inline-flex items-center gap-1.5 rounded-full border border-beige-line bg-card px-4 py-2 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
              aria-hidden
            >
              <polyline points="21 3 21 9 15 9" />
              <polyline points="3 21 3 15 9 15" />
              <path d="M3.5 9a9 9 0 0 1 15-3.5L21 9" />
              <path d="M20.5 15a9 9 0 0 1-15 3.5L3 15" />
            </svg>
            Rerun
          </button>
        </div>
      </div>

      <div className="mt-8 grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {order.map((k) => {
          const c = data.checks[k];
          const color = scoreColor(c.score);
          return (
            <div
              key={k}
              className="flex flex-col items-center gap-1 rounded-card border border-beige-line bg-bg/40 px-3 py-3"
            >
              <div
                className="flex h-7 w-7 items-center justify-center rounded-lg"
                style={{ background: `${color}1a`, color }}
              >
                <span className="h-3.5 w-3.5">{CHECK_META[k].icon}</span>
              </div>
              <div
                className="text-[22px] font-bold tabular-nums leading-none tracking-tight"
                style={{ color }}
              >
                {c.score}
              </div>
              <div
                className="text-[10px] font-bold uppercase text-ink-soft text-center"
                style={{ letterSpacing: "0.06em" }}
              >
                {CHECK_META[k].title}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BreakdownBlock({ data }: { data: AnalyzeResponse }) {
  const order: CheckKey[] = [
    "speed",
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {order.map((k) => (
        <ScoreCard
          key={k}
          title={CHECK_META[k].title}
          icon={CHECK_META[k].icon}
          result={data.checks[k] as CheckResult}
        />
      ))}
    </div>
  );
}

function KeyTakeawaysBlock({ data }: { data: AnalyzeResponse }) {
  const items = data.keyTakeaways ?? [];
  if (items.length === 0) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        No takeaways were returned for this run.
      </p>
    );
  }
  return (
    <ol className="m-0 flex flex-col gap-3 p-0 list-none">
      {items.map((text, i) => (
        <li
          key={i}
          className="flex items-start gap-3 rounded-card border border-beige-line bg-bg/40 px-4 py-3"
        >
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-white tabular-nums">
            {i + 1}
          </span>
          <span className="text-sm font-medium leading-[1.6] text-ink">
            {text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ScreenshotsBlock({ data }: { data: AnalyzeResponse }) {
  if (!data.desktopScreenshot && !data.mobileScreenshot) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        PageSpeed Insights didn&apos;t return screenshots for this run.
      </p>
    );
  }
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {data.desktopScreenshot && (
        <ScreenshotCard
          label="DESKTOP"
          src={data.desktopScreenshot}
        />
      )}
      {data.mobileScreenshot && (
        <ScreenshotCard
          label="MOBILE"
          src={data.mobileScreenshot}
        />
      )}
    </div>
  );
}

function ScreenshotCard({ label, src }: { label: string; src: string }) {
  return (
    <div className="overflow-hidden rounded-card border border-beige-line bg-card">
      <div
        className="flex items-center justify-between border-b border-beige-line px-4 py-3 text-[11px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.12em" }}
      >
        <span>{label}</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer noopener"
          className="text-ink-soft hover:text-accent"
        >
          Open full size ↗
        </a>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={label}
        className="block w-full"
        style={{ imageRendering: "auto" }}
      />
    </div>
  );
}

/* ---------- Saved Reports panel ---------- */
function SavedReportsPanel({
  reports,
  backgroundRunning,
  onOpen,
  onRerun,
  onRename,
  onDelete,
  onClose,
}: {
  reports: AnalyzeResponse[];
  backgroundRunning: Set<string>;
  onOpen: (r: AnalyzeResponse) => void;
  onRerun: (r: AnalyzeResponse) => void;
  onRename: (url: string, name: string) => void;
  onDelete: (url: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-[24px] border border-beige-line bg-card p-7 shadow-card">
      <div className="flex items-center justify-between gap-4">
        <h2
          className="m-0 text-[12px] font-bold uppercase text-ink-soft"
          style={{ letterSpacing: "0.18em" }}
        >
          Your Saved Reports
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] font-semibold text-ink-soft hover:text-ink"
        >
          Close
        </button>
      </div>

      {reports.length === 0 ? (
        <p className="mt-5 text-sm font-medium text-ink-soft">
          You haven&apos;t run a report yet. When you do, it&apos;ll save here
          automatically so you can revisit or rerun it later.
        </p>
      ) : (
        <ul className="mt-5 m-0 flex flex-col gap-2.5 p-0 list-none">
          {reports.map((r) => (
            <SavedReportRow
              key={r.url}
              report={r}
              running={backgroundRunning.has(r.url)}
              onOpen={() => onOpen(r)}
              onRerun={() => onRerun(r)}
              onRename={(name) => onRename(r.url, name)}
              onDelete={() => onDelete(r.url)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SavedReportRow({
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
  const [draftName, setDraftName] = useState(
    report.name ?? prettyUrl(report.url),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // When the user clicks the pencil, focus + select the input.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Keep the local draft in sync if the report (or its name) updates after a
  // background rerun.
  useEffect(() => {
    if (!editing) setDraftName(report.name ?? prettyUrl(report.url));
  }, [report.name, report.url, editing]);

  function commitRename() {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== (report.name ?? "")) onRename(trimmed);
    setEditing(false);
  }

  return (
    <li className="flex flex-wrap items-center gap-4 rounded-card border border-beige-line bg-bg/40 px-4 py-3">
      <div
        className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full font-bold tabular-nums"
        style={{ background: `${color}1a`, color, fontSize: 18 }}
      >
        {report.overall}
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraftName(report.name ?? prettyUrl(report.url));
                setEditing(false);
              }
            }}
            className="w-full rounded-md border border-accent bg-card px-2 py-1 text-[14px] font-bold tracking-tight text-ink outline-none focus:ring-4 focus:ring-accent-soft"
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 max-w-full truncate text-left text-[14px] font-bold tracking-tight text-ink hover:text-accent"
              title={report.url}
            >
              {report.name ?? prettyUrl(report.url)}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Rename this report"
              title="Rename"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-bg hover:text-accent"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
                aria-hidden
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
          </div>
        )}
        <div className="mt-0.5 text-[12px] font-medium text-ink-soft">
          {report.name ? prettyUrl(report.url) + " · " : ""}
          {new Date(report.analyzedAt).toLocaleString()}
          {running && (
            <span className="ml-2 inline-flex items-center gap-1 text-accent">
              <Spinner className="text-accent" />
              Rerunning…
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-full border border-beige-line bg-card px-3.5 py-1.5 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onRerun}
          disabled={running}
          className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? "Running…" : "Rerun"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove this saved report"
          className="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition hover:bg-bg hover:text-bad"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </li>
  );
}

function prettyUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return u;
  }
}

function overallSummary(score: number): string {
  if (score >= 90)
    return "This page is firing on every dimension we test. Look for fine-tuning rather than fixes.";
  if (score >= 75)
    return "A strong, well-built page. A few targeted improvements would push it into best-in-class territory.";
  if (score >= 60)
    return "Solid baseline but real conversion is being left on the table. The cards below show what to fix first.";
  if (score >= 40)
    return "There are meaningful weaknesses across multiple dimensions. Prioritise the lowest-scoring cards.";
  return "This page has significant problems holding back performance and conversions. Treat the recommendations below as urgent.";
}

function FeaturesGrid() {
  const items = [
    {
      icon: <IconBolt />,
      title: "Speed",
      desc: "Real Lighthouse scores for desktop and mobile, including LCP, CLS and TBT.",
    },
    {
      icon: <IconText />,
      title: "Content",
      desc: "How clear and compelling is the copy? Is the value proposition obvious?",
    },
    {
      icon: <IconLayers />,
      title: "Digestibility",
      desc: "Visual hierarchy, scannability, navigation, and information architecture.",
    },
    {
      icon: <IconTarget />,
      title: "CRO",
      desc: "Buttons, forms, calls to action, and friction in your conversion path.",
    },
    {
      icon: <IconEye />,
      title: "Above the fold",
      desc: "What every visitor sees in the first viewport before they scroll.",
    },
    {
      icon: <IconPhone />,
      title: "Mobile layout",
      desc: "Real mobile render — tap targets, font sizes, overflow, hidden CTAs.",
    },
  ];
  return (
    <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div
          key={it.title}
          className="flex items-start gap-3.5 rounded-card border border-beige-line bg-card p-4"
        >
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-dark">
            {it.icon}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-bold tracking-tight text-ink">
              {it.title}
            </h3>
            <p className="mt-1 text-[12px] font-medium leading-[1.55] text-ink-soft">
              {it.desc}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Icons ---------- */
function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
function IconText() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  );
}
function IconTarget() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px]" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
function IconEye() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconPhone() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[18px] w-[18px]" aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  );
}
function IconReport() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h6" />
      <path d="M8 17h8" />
    </svg>
  );
}
