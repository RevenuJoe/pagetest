"use client";

import { cloneElement, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Header from "@/components/Header";
import Results from "@/components/Results";
import { Spinner } from "@/components/Icons";
import { analysisStore } from "@/lib/analysisStore";
import { savedStore } from "@/lib/savedStore";
import { useActiveRun, useSavedReports } from "@/lib/storeHooks";
import type { AnalyzeResponse } from "@/lib/types";

const LOADING_STEPS = [
  "Booting Lighthouse on Google's servers…",
  "Measuring Largest Contentful Paint…",
  "Capturing desktop above-the-fold…",
  "Running the mobile audit…",
  "Reading the page content…",
  "Asking Claude to grade the page…",
  "Compiling your report…",
];

// Once we land on the final "compiling" step we cycle through these every
// few seconds so the message doesn't sit static while the analysis
// finishes. "Compiling your report…" is interleaved between the engaging
// callouts so it always feels like that's the underlying state.
const COMPILING_ROTATION = [
  "Compiling your report…",
  "Not too long now, it's worth the wait.",
  "Compiling your report…",
  "Putting together the report still…",
  "Compiling your report…",
  "Not too long now, it's worth the wait.",
];

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <Home />
    </Suspense>
  );
}

function Home() {
  const router = useRouter();
  const params = useSearchParams();
  const queryUrl = params.get("url");

  const [formUrl, setFormUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Subscribe to savedStore and active runs so the UI reacts when an
  // analysis kicked off from anywhere completes.
  const savedReports = useSavedReports();
  const activeRun = useActiveRun(queryUrl);

  // The URL we're currently displaying a result for. When the page is loaded
  // with `?url=…`, this is queryUrl. Otherwise it tracks whatever the user
  // most recently submitted via the form.
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);
  const focusUrl = queryUrl || submittedUrl;
  const focusRun = useActiveRun(focusUrl);
  const focusSaved: AnalyzeResponse | undefined = focusUrl
    ? savedReports.find((r) => r.url === focusUrl)
    : undefined;

  const isLoading = focusRun?.state === "running";
  const focusResult: AnalyzeResponse | undefined =
    focusRun?.state === "done" ? focusRun.result : focusSaved;

  // Animation phase for the run flow:
  //   idle    — hero + features visible
  //   running — only the centred progress card
  //   ready   — brief "Report ready" with animated tick
  //   showing — the Results view (slides in from the left)
  type Phase = "idle" | "running" | "ready" | "showing";
  const [phase, setPhase] = useState<Phase>(() =>
    focusResult ? "showing" : "idle",
  );
  // Track whether the current result came from THIS session's run (so we
  // celebrate) or was already saved when the page loaded (no celebration).
  const lastRunRef = useRef<string | null>(null);

  // Drive phase from loading + result state.
  useEffect(() => {
    if (isLoading) {
      setPhase("running");
      return;
    }
    if (focusResult) {
      // Just finished a run we kicked off → celebration first, then results.
      if (lastRunRef.current === focusUrl) {
        lastRunRef.current = null;
        setPhase("ready");
        const t = window.setTimeout(() => setPhase("showing"), 1400);
        return () => window.clearTimeout(t);
      }
      // Saved or already-displayed report → go straight to results.
      setPhase("showing");
      return;
    }
    setPhase("idle");
  }, [isLoading, focusResult, focusUrl]);

  // Step-text cycle while an analysis is in flight.
  useEffect(() => {
    if (!isLoading) return;
    setStepIndex(0);
    const id = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, LOADING_STEPS.length - 1));
    }, 6000);
    return () => clearInterval(id);
  }, [isLoading]);

  // Once stepIndex has landed on the FINAL "Compiling your report…" step
  // (the one that tends to linger), rotate through engaging messages
  // every ~3 seconds so the user feels something is still happening.
  const [rotationIndex, setRotationIndex] = useState(0);
  useEffect(() => {
    const onLastStep = stepIndex === LOADING_STEPS.length - 1;
    if (!isLoading || !onLastStep) {
      setRotationIndex(0);
      return;
    }
    const id = setInterval(() => {
      setRotationIndex((i) => (i + 1) % COMPILING_ROTATION.length);
    }, 5000);
    return () => clearInterval(id);
  }, [isLoading, stepIndex]);

  // When the report finishes its slide-in, scroll it into view.
  useEffect(() => {
    if (phase === "showing" && focusResult && resultsRef.current) {
      resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [phase, focusResult]);

  // Surface analysisStore errors as the local error banner.
  useEffect(() => {
    if (focusRun?.state === "error" && focusRun.error) {
      setError(focusRun.error);
    }
  }, [focusRun]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formUrl.trim()) return;
    setError(null);
    setSubmittedUrl(formUrl);
    lastRunRef.current = formUrl;
    const existing = savedStore.find(formUrl);
    analysisStore.start(formUrl, { preserveName: existing?.name });
    // If the form URL doesn't match the query URL, swap the query so refresh
    // links back to this run.
    if (queryUrl !== formUrl) {
      router.replace(`/?url=${encodeURIComponent(formUrl)}`);
    }
  }

  function rerun() {
    if (!focusUrl) return;
    const existing = savedStore.find(focusUrl);
    setError(null);
    lastRunRef.current = focusUrl;
    analysisStore.start(focusUrl, { preserveName: existing?.name });
  }

  return (
    <div className="min-h-screen">
      {/* Page-specific JSON-LD: WebPage + FAQPage. Helps Google and AI search
          parsers understand the page's intent and surface answers directly. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebPage",
                "@id": "https://pages.revenuagency.io/#webpage",
                url: "https://pages.revenuagency.io/",
                name: "Landing Page Tester | Revenu",
                isPartOf: {
                  "@id": "https://pages.revenuagency.io/#website",
                },
                description:
                  "Score any landing page in 60 seconds. Speed, content, digestibility, CRO, above-the-fold and mobile, all scored automatically.",
                inLanguage: "en-GB",
                primaryImageOfPage: {
                  "@type": "ImageObject",
                  url: "https://pages.revenuagency.io/favicon/favicon-192.png",
                },
              },
              {
                "@type": "FAQPage",
                mainEntity: [
                  {
                    "@type": "Question",
                    name: "What does the Revenu Landing Page Tester score?",
                    acceptedAnswer: {
                      "@type": "Answer",
                      text: "Six dimensions for any landing page: load speed (via Google PageSpeed Insights / Lighthouse), content quality, digestibility, conversion rate optimisation (CRO), above-the-fold strength, and mobile layout. Each scored 0 to 100, with a concrete prioritised list of fixes.",
                    },
                  },
                  {
                    "@type": "Question",
                    name: "How long does a test take?",
                    acceptedAnswer: {
                      "@type": "Answer",
                      text: "Around 30 to 60 seconds. Lighthouse runs a full real-world render on Google's servers, then Claude analyses the page text and screenshots in parallel.",
                    },
                  },
                  {
                    "@type": "Question",
                    name: "Is it free?",
                    acceptedAnswer: {
                      "@type": "Answer",
                      text: "Yes. The tester is provided free by Revenu Agency. No login required.",
                    },
                  },
                  {
                    "@type": "Question",
                    name: "Do reports save automatically?",
                    acceptedAnswer: {
                      "@type": "Answer",
                      text: "Yes. Every test you run is saved in your browser. Open the report icon in the top right to revisit, rename, rerun, or delete past reports.",
                    },
                  },
                ],
              },
            ],
          }),
        }}
      />
      <Header />

      <main className="mx-auto max-w-[1180px] px-6 sm:px-14">
        {/* Idle hero: visible only when phase === 'idle'. Fades + slides up
            out of the way when a run starts. `pointer-events-none` while
            hidden so the centred progress card never gets covered. */}
        <section
          className={
            "pt-[50px] md:pt-[72px] transition-all duration-500 ease-out " +
            (phase === "idle"
              ? "opacity-100 translate-y-0"
              : "pointer-events-none opacity-0 -translate-y-3")
          }
          aria-hidden={phase !== "idle"}
          style={phase !== "idle" ? { display: "none" } : undefined}
        >
          <div className="text-center">
            <h1 className="text-[clamp(32px,4.7vw,54px)] font-bold leading-[1.04] tracking-tight text-ink">
              Score Your{" "}
              <span style={{ color: "#76A09C" }}>B2B</span>
              {" "}Landing Page
            </h1>
            <HeroPills />
          </div>

          <form
            onSubmit={onSubmit}
            className="mx-auto mt-9 flex w-full max-w-[768px] flex-col items-stretch gap-2.5 sm:flex-row"
          >
            <div className="relative flex-1">
              <span
                className="pointer-events-none absolute inset-y-0 left-4 flex items-center"
                style={{ color: "#98a0a4" }}
              >
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
                placeholder="Enter your landing page URL"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                disabled={isLoading}
                className="w-full rounded-[14px] border border-beige-line bg-card py-[13px] pl-12 pr-4 text-[15px] font-medium text-ink outline-none transition placeholder:font-medium placeholder:text-[#98a0a4] focus:border-accent focus:ring-4 focus:ring-accent-soft disabled:opacity-60"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !formUrl.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-[14px] bg-accent px-[29px] py-[13px] text-sm font-semibold tracking-[0.01em] text-white transition hover:bg-accent-dark active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isLoading ? (
                <>
                  <Spinner className="h-4 w-4" />
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

          {/* Trust line under the form: subtle, two-up. Each item has its
              own icon — envelope-with-slash for "No email required" and a
              gift/badge for "100% free". */}
          {!isLoading && (
            <div className="mt-5 flex items-center justify-center gap-7 text-[13px] font-medium text-ink-soft">
              <span className="inline-flex items-center gap-2">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent-soft text-accent-dark">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[11px] w-[11px]" aria-hidden>
                    <path d="M4 6h16v12H4z" />
                    <path d="M4 7l8 6 8-6" />
                    <line x1="3" y1="3" x2="21" y2="21" />
                  </svg>
                </span>
                No email required
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent-soft text-accent-dark">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[11px] w-[11px]" aria-hidden>
                    <polyline points="20 12 20 22 4 22 4 12" />
                    <rect x="2" y="7" width="20" height="5" />
                    <line x1="12" y1="22" x2="12" y2="7" />
                    <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
                    <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
                  </svg>
                </span>
                100% free
              </span>
            </div>
          )}

          {error && phase === "idle" && (
            <div className="mx-auto mt-[18px] max-w-[640px] rounded-[14px] border border-[#f1c9c5] bg-[#fbece9] px-4 py-3.5 text-sm font-medium text-bad">
              {error}
            </div>
          )}
        </section>

        {/* Running: centred progress card. Only thing on screen apart from
            the nav. Fades in when phase flips from idle to running. */}
        {phase === "running" && (
          <section className="mx-auto mt-24 max-w-[640px] animate-[fadeIn_360ms_ease-out]">
            <div className="rounded-card border border-beige-line bg-card p-[22px] shadow-card">
              <div className="flex items-center gap-3">
                <Spinner className="h-[18px] w-[18px] text-accent" />
                <p className="text-sm font-semibold text-ink">
                  {stepIndex === LOADING_STEPS.length - 1
                    ? COMPILING_ROTATION[rotationIndex]
                    : LOADING_STEPS[stepIndex]}
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
                This usually takes 30 to 60 seconds. Lighthouse is doing a
                full real-world render of the page.
              </p>
              {focusUrl && (
                <p className="mt-3 break-all text-xs font-medium text-ink-soft">
                  URL: <span className="text-ink">{focusUrl}</span>
                </p>
              )}
            </div>
          </section>
        )}

        {/* Ready: brief celebration with an animated tick before the report
            slides in. */}
        {phase === "ready" && (
          <section className="mx-auto mt-24 flex max-w-[640px] flex-col items-center text-center animate-[fadeIn_300ms_ease-out]">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-accent-dark">
              <AnimatedTick />
            </span>
            <p className="mt-4 text-[18px] font-bold tracking-tight text-ink">
              Your report is ready.
            </p>
            <p className="mt-1 text-[13px] font-medium text-ink-soft">
              Bringing it in now…
            </p>
          </section>
        )}

        {/* Results: only when phase is 'showing'. The Results component
            handles its own staggered section reveal — each section slides
            in from the left in sequence with page scroll following along,
            then a glide back up to the Overview at the end. */}
        {phase === "showing" && focusResult && (
          <section
            ref={resultsRef}
            className="mt-12 scroll-mt-12"
          >
            <Results
              data={focusResult}
              onRerun={rerun}
              rerunning={false}
            />
          </section>
        )}

        {phase === "idle" && (
          <section className="mt-[72px]">
            <div
              className="mx-auto mb-[72px] h-px max-w-[760px]"
              style={{ background: "rgba(28,31,29,0.08)" }}
            />
            {/* Constrain the features grid to 70% of the container width so
                the six boxes read narrower than the hero, matching Joe's
                reference. Centered. */}
            <div className="mx-auto" style={{ maxWidth: "70%" }}>
              <FeaturesGrid />
            </div>
          </section>
        )}
      </main>

      <footer className="mt-[72px] border-t border-beige-line bg-bg py-9 text-center text-[14px] text-ink-soft">
        <div className="mx-auto max-w-[1180px] px-6 sm:px-14">
          <p className="m-0">© Revenu</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Animated tick (Report ready celebration) ---------- */
function AnimatedTick() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-8 w-8"
      aria-hidden
    >
      <path
        d="M5 12l5 5L20 7"
        style={{
          strokeDasharray: 24,
          strokeDashoffset: 24,
          animation: "tickDraw 500ms ease-out 120ms forwards",
        }}
      />
    </svg>
  );
}

/* ---------- Hero pill explainers ---------- */
function HeroPills() {
  const items: { label: string; svg: React.ReactNode }[] = [
    {
      label: "Enter your landing page URL",
      svg: (
        <svg
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
        </svg>
      ),
    },
    {
      label: "We'll check its speed with Google Page Insights",
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden>
          <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      ),
    },
    {
      label: "We'll analyse its content with Claude",
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden>
          <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
        </svg>
      ),
    },
  ];
  return (
    <ul className="mx-auto mt-7 flex flex-wrap items-center justify-center gap-2.5 p-0 list-none">
      {items.map(({ label, svg }) => (
        <li
          key={label}
          className="inline-flex items-center gap-2 rounded-full border border-beige-line bg-card py-1 pl-1 pr-3.5 text-[12px] font-medium text-ink"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent-dark">
            {svg}
          </span>
          {label}
        </li>
      ))}
    </ul>
  );
}

/* ---------- Features grid (idle state) ---------- */
import {
  IconBolt,
  IconText,
  IconLayers,
  IconTarget,
  IconEye,
  IconPhone,
} from "@/components/Icons";

function FeaturesGrid() {
  const items = [
    { icon: <IconBolt />, title: "Speed", desc: "Real Lighthouse scores for desktop and mobile, including LCP, CLS and TBT." },
    { icon: <IconText />, title: "Content", desc: "How clear and compelling is the copy? Is the value proposition obvious?" },
    { icon: <IconLayers />, title: "Digestibility", desc: "Visual hierarchy, scannability, navigation, and information architecture." },
    { icon: <IconTarget />, title: "CRO", desc: "Buttons, forms, calls to action, and friction in your conversion path." },
    { icon: <IconEye />, title: "Above the fold", desc: "What every visitor sees in the first viewport before they scroll." },
    { icon: <IconPhone />, title: "Mobile layout", desc: "Real mobile render. Tap targets, font sizes, overflow, hidden CTAs." },
  ];
  return (
    // Boxes scaled ~20% smaller: tighter grid gap, less padding inside each
    // card, smaller icon container, and slightly smaller copy.
    <div className="grid gap-[22px] sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div
          key={it.title}
          className="flex items-start gap-3 rounded-card border border-beige-line bg-card p-[13px]"
        >
          <div className="flex h-[29px] w-[29px] flex-shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-dark">
            {cloneElement(it.icon as React.ReactElement<{ className?: string }>, { className: "h-[14px] w-[14px]" })}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[11.5px] font-bold tracking-tight text-ink">
              {it.title}
            </h3>
            <p className="mt-1 text-[10.5px] font-medium leading-[1.55] text-ink-soft">
              {it.desc}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
