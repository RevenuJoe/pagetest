/**
 * /report — minimal viewer for a single saved report.
 *
 * Opened from the Saved Reports list. URL pattern is /report?url=<encoded>.
 * One canonical route for every saved report keeps the URL structure simple.
 *
 * The page deliberately omits the home page's hero, Run analysis form, and
 * features grid. It shows only the header, the Results view, and the footer.
 * If a rerun is in flight for this URL, a progress card sits above the
 * (previously saved) report so the user keeps context while the new run
 * works.
 */

"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import Results from "@/components/Results";
import {
  Spinner,
  IconSearch,
  IconGauge,
  IconCamera,
  IconScale,
  IconText,
  IconStar,
  IconReport,
  IconClock,
  IconHourglass,
  IconCheck,
  IconWrench,
} from "@/components/Icons";
import { analysisStore } from "@/lib/analysisStore";
import { savedStore } from "@/lib/savedStore";
import { useActiveRun, useSavedReports } from "@/lib/storeHooks";
import type { AnalyzeResponse } from "@/lib/types";

interface LoadingStep {
  text: string;
  icon: React.ReactNode;
}

const LOADING_STEPS: LoadingStep[] = [
  { text: "Booting up Lighthouse on the Google's servers…", icon: <IconSearch /> },
  { text: "Running speed checks on mobile and desktop…", icon: <IconGauge /> },
  { text: "Screenshotting above the fold loads…", icon: <IconCamera /> },
  { text: "Comparing to best practices…", icon: <IconScale /> },
  { text: "Reading the page content…", icon: <IconText /> },
  { text: "Claude is grading page against Revenu criteria…", icon: <IconStar /> },
  { text: "Compiling your report…", icon: <IconReport /> },
];

// Engaging cycle for the final "Compiling" step (used during reruns).
const COMPILING_ROTATION: LoadingStep[] = [
  { text: "Not too long now, it's worth the wait...", icon: <IconClock /> },
  { text: "It's nearly ready...", icon: <IconHourglass /> },
  { text: "I promise it's basically done", icon: <IconCheck className="h-[18px] w-[18px]" /> },
  { text: "Last tweaks", icon: <IconWrench /> },
  { text: "Wow this is strange, sorry", icon: <IconHourglass /> },
  { text: "It's nearly ready...", icon: <IconClock /> },
];

export default function ReportPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <ReportView />
    </Suspense>
  );
}

function ReportView() {
  const params = useSearchParams();
  const queryUrl = params.get("url");

  const savedReports = useSavedReports();
  const activeRun = useActiveRun(queryUrl);

  const focusSaved: AnalyzeResponse | undefined = queryUrl
    ? savedReports.find((r) => r.url === queryUrl)
    : undefined;

  const isLoading = activeRun?.state === "running";
  const focusResult: AnalyzeResponse | undefined =
    activeRun?.state === "done" ? activeRun.result : focusSaved;

  // Cycle progress text while a rerun is in flight.
  const [stepIndex, setStepIndex] = useState(0);
  useEffect(() => {
    if (!isLoading) return;
    setStepIndex(0);
    const id = window.setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, LOADING_STEPS.length - 1));
    }, 6000);
    return () => window.clearInterval(id);
  }, [isLoading]);

  // Once stepIndex is parked on the final "Compiling" step, rotate
  // engaging messages every ~3 seconds so it never feels stuck.
  const [rotationIndex, setRotationIndex] = useState(0);
  useEffect(() => {
    const onLastStep = stepIndex === LOADING_STEPS.length - 1;
    if (!isLoading || !onLastStep) {
      setRotationIndex(0);
      return;
    }
    const id = window.setInterval(() => {
      setRotationIndex((i) => (i + 1) % COMPILING_ROTATION.length);
    }, 5000);
    return () => window.clearInterval(id);
  }, [isLoading, stepIndex]);

  // No automatic scroll when the report lands — the user controls
  // scrolling. The animation runs in place wherever the page currently
  // sits.
  const resultsRef = useRef<HTMLDivElement>(null);

  function rerun() {
    if (!queryUrl) return;
    const existing = savedStore.find(queryUrl);
    analysisStore.start(queryUrl, { preserveName: existing?.name });
  }

  // No URL: show a friendly empty state.
  if (!queryUrl) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-[1180px] px-6 pb-24 sm:px-14">
          <section className="pt-20 text-center">
            <h1 className="text-[clamp(24px,3.4vw,36px)] font-bold leading-[1.05] tracking-tight text-ink">
              No report selected
            </h1>
            <p className="mx-auto mt-3 max-w-[520px] text-[14px] font-medium leading-[1.6] text-ink-soft">
              Pick a saved report to view it here, or run a fresh analysis from
              the home page.
            </p>
            <div className="mt-7 flex items-center justify-center gap-3">
              <Link
                href="/reports"
                className="inline-flex items-center gap-2 rounded-full border border-beige-line bg-card px-5 py-2 text-[13px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
              >
                Saved reports
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-dark"
              >
                Run a new analysis
              </Link>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-[1180px] px-6 pb-24 sm:px-14">
        <section className="pt-10 md:pt-14">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/reports"
              className="whitespace-nowrap text-[13px] font-semibold text-ink-soft hover:text-ink"
            >
              ← Back to saved reports
            </Link>
            {focusResult && !isLoading && (
              <button
                type="button"
                onClick={rerun}
                className="whitespace-nowrap rounded-full border border-beige-line bg-card px-4 py-1.5 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
              >
                Rerun this report
              </button>
            )}
          </div>
        </section>

        {isLoading && (() => {
          const current =
            stepIndex === LOADING_STEPS.length - 1
              ? COMPILING_ROTATION[rotationIndex]
              : LOADING_STEPS[stepIndex];
          return (
          <section className="mx-auto mt-7 max-w-[640px]">
            <div className="rounded-card border border-beige-line bg-card p-[22px] shadow-card">
              <div className="flex items-center gap-3">
                {/* Step-specific icon in a small green chip. Same pattern
                    as the home page running card. */}
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent-dark">
                  {current.icon}
                </span>
                <p className="text-sm font-semibold text-ink">
                  {current.text}
                </p>
              </div>
              {/* Spinner on the LEFT, progress bar fills the rest of the
                  row. Mirrors the layout on the home page running card. */}
              <div className="mt-3.5 flex items-center gap-3">
                <Spinner className="h-4 w-4 flex-shrink-0 text-accent" />
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-beige-line">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-[800ms] ease-out"
                    style={{
                      width: `${((stepIndex + 1) / LOADING_STEPS.length) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <p className="mt-3 text-xs font-medium text-ink-soft">
                This is a detailed analysis using multiple APIs, it can take
                1 to 2 minutes.
              </p>
              <p className="mt-3 break-all text-xs font-medium text-ink-soft">
                URL: <span className="text-ink">{queryUrl}</span>
              </p>
            </div>
          </section>
          );
        })()}

        {focusResult && (
          <section ref={resultsRef} className="mt-8 scroll-mt-12">
            <Results data={focusResult} onRerun={rerun} rerunning={isLoading} />
          </section>
        )}

        {!focusResult && !isLoading && (
          <section className="mt-16 text-center">
            <p className="text-[14px] font-medium text-ink-soft">
              We don&apos;t have a saved report for this URL yet.
            </p>
            <Link
              href="/reports"
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-beige-line bg-card px-5 py-2 text-[13px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent"
            >
              Browse saved reports
            </Link>
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-5 border-t border-beige-line bg-bg py-9 text-center text-[14px] text-ink-soft">
      <div className="mx-auto max-w-[1180px] px-6 sm:px-14">
        <p className="m-0">© Revenu</p>
      </div>
    </footer>
  );
}
