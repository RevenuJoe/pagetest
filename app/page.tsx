"use client";

import { useEffect, useRef, useState } from "react";
import type { AnalyzeResponse } from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";
import ScoreCard from "@/components/ScoreCard";

const LOADING_STEPS = [
  "Booting Lighthouse on Google's servers…",
  "Measuring Largest Contentful Paint…",
  "Capturing desktop above-the-fold…",
  "Running the mobile audit…",
  "Reading the page content…",
  "Asking Claude to grade the page…",
  "Compiling your report…",
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading) return;
    setStepIndex(0);
    const id = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, LOADING_STEPS.length - 1));
    }, 6000);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (result && resultsRef.current) {
      resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Something went wrong. Please try again.");
      } else {
        setResult(body as AnalyzeResponse);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-[1180px] px-6 pb-24 sm:px-14">
        <section className="pt-14 md:pt-20">
          <div className="text-center">
            <h1 className="text-[clamp(32px,4.7vw,54px)] font-bold leading-[1.04] tracking-tight text-ink">
              Score any landing page in{" "}
              <span style={{ color: "#76A09C" }}>60 seconds</span>.
            </h1>
            <ul className="mx-auto mt-7 flex flex-wrap items-center justify-center gap-2.5 p-0 list-none">
              {[
                "Speed test via Google",
                "Context",
                "Content analysis by Claude",
              ].map((label, i) => (
                <li
                  key={label}
                  className="inline-flex items-center gap-2 rounded-full border border-beige-line bg-card py-1 pl-1 pr-3.5 text-[12px] font-medium text-ink"
                >
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ background: "#76A09C" }}
                  >
                    {i + 1}
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

        {result && (
          <section ref={resultsRef} className="mt-16 scroll-mt-12">
            <Results data={result} />
          </section>
        )}

        {!loading && !result && (
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

function Header() {
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
        <a
          href="https://www.revenuagency.io"
          target="_blank"
          rel="noreferrer"
          className="text-[13px] font-semibold text-ink-soft hover:text-ink"
        >
          revenuagency.io ↗
        </a>
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

function Results({ data }: { data: AnalyzeResponse }) {
  return (
    <div>
      <div className="flex flex-col items-center gap-8 rounded-[24px] border border-beige-line bg-card p-8 shadow-card md:flex-row md:items-center md:gap-8 md:p-10">
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
      </div>

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ScoreCard
          title="Speed"
          icon={<IconBolt />}
          result={data.checks.speed}
        />
        <ScoreCard
          title="Content"
          icon={<IconText />}
          result={data.checks.content}
        />
        <ScoreCard
          title="Digestibility"
          icon={<IconLayers />}
          result={data.checks.digestibility}
        />
        <ScoreCard
          title="CRO"
          icon={<IconTarget />}
          result={data.checks.cro}
        />
        <ScoreCard
          title="Above the fold"
          icon={<IconEye />}
          result={data.checks.aboveTheFold}
        />
        <ScoreCard
          title="Mobile layout"
          icon={<IconPhone />}
          result={data.checks.mobile}
        />
      </div>

      {(data.desktopScreenshot || data.mobileScreenshot) && (
        <div className="mt-9 grid gap-6 md:grid-cols-2">
          {data.desktopScreenshot && (
            <ScreenshotCard
              label="DESKTOP ABOVE-THE-FOLD"
              src={data.desktopScreenshot}
            />
          )}
          {data.mobileScreenshot && (
            <ScreenshotCard
              label="MOBILE ABOVE-THE-FOLD"
              src={data.mobileScreenshot}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ScreenshotCard({ label, src }: { label: string; src: string }) {
  return (
    <div className="overflow-hidden rounded-card border border-beige-line bg-card shadow-card">
      <div
        className="border-b border-beige-line px-4 py-3 text-[11px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={label} className="w-full" />
    </div>
  );
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
          className="rounded-card border border-beige-line bg-card p-4"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent-dark">
            {it.icon}
          </div>
          <h3 className="mt-3 text-[13px] font-bold tracking-tight text-ink">
            {it.title}
          </h3>
          <p className="mt-1 text-[12px] font-medium leading-[1.55] text-ink-soft">
            {it.desc}
          </p>
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
