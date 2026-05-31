/**
 * The six-section report view. Shared between / (after a fresh run) and
 * /reports (when opening a saved report).
 *
 *   1. Overview                     — overall ring + Report name/URL/Analysed + mini scores
 *   2. Key Recommendations          — numbered list from Claude
 *   3. PageSpeed Insights           — 10 Desktop vs Mobile bar charts + numbered summary
 *   4. Analysis                     — six ScoreCards (one per dimension)
 *   5. Above-the-Fold Screenshots   — desktop + mobile at matched height
 *   6. Technical Improvements       — Lighthouse opportunities + diagnostics
 */

"use client";

import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AnalyzeResponse,
  CheckKey,
  CheckResult,
  PsiBreakdown,
  TechnicalImprovement,
} from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";
import ScoreCard from "@/components/ScoreCard";
import Section from "@/components/Section";
import {
  CHECK_META,
  IconCopy,
  IconCheck,
  IconChevron,
  IconReport,
  IconLayers,
  IconBulb,
  IconWrench,
  IconGauge,
  IconEye,
  IconDownload,
} from "@/components/Icons";
import { scoreColor } from "@/lib/scoreColor";
import { displayName } from "@/lib/nameUtil";
import Lightbox, { type LightboxMode } from "@/components/Lightbox";

/**
 * Shape of the currently-open lightbox. `null` means nothing is open.
 * - `src` is the WebP URL (or PSI data URL) being displayed.
 * - `mode` decides layout: "atf" centers + fits, "fullpage" scrolls.
 * The state lives at the Results level so it doesn't matter which child
 * section asks to open it — the overlay always renders at the root of the
 * report and covers the whole viewport.
 */
type LightboxState = { src: string; mode: LightboxMode; alt?: string } | null;

/**
 * Context plumbing for "click this image to open it in the lightbox".
 * Children inside Results don't need to thread a callback through props —
 * they just call useLightboxOpen() and invoke it. Defined here (not its
 * own file) because it's only used inside this component tree.
 */
const LightboxContext = createContext<((s: LightboxState) => void) | null>(null);
export function useLightboxOpen() {
  return useContext(LightboxContext);
}

export default function Results({
  data,
  onRerun,
  rerunning = false,
}: {
  data: AnalyzeResponse;
  onRerun?: () => void;
  rerunning?: boolean;
}) {
  // Lightbox state shared across every screenshot in the report. Children
  // call `openLightbox(...)` via context; the overlay renders once at the
  // end of this component so it covers the whole viewport regardless of
  // which section the thumbnail lives in.
  const [lightbox, setLightbox] = useState<LightboxState>(null);
  const openLightbox = useCallback((s: LightboxState) => setLightbox(s), []);
  const closeLightbox = useCallback(() => setLightbox(null), []);

  // Each report section is described once here so we can drive the
  // staggered reveal in a loop. Only "The Overview" (the first entry) is
  // open by default; the rest are collapsed until the user clicks them.
  const sections: Array<{
    key: string;
    node: React.ReactNode;
  }> = [
    {
      key: "overview",
      node: (
        <Section
          title={displayName(data)}
          icon={<IconReport className="h-[18px] w-[18px]" />}
          defaultOpen
          headerAction={
            <CopyButton getText={() => formatOverviewForClipboard(data)} />
          }
        >
          <OverviewBlock data={data} onRerun={onRerun} rerunning={rerunning ?? false} />
        </Section>
      ),
    },
    {
      key: "takeaways",
      node: (
        <Section
          title="Key Recommendations"
          icon={<IconBulb />}
          defaultOpen
          headerAction={
            <CopyButton getText={() => formatTakeawaysForClipboard(data)} />
          }
        >
          <KeyTakeawaysBlock data={data} />
        </Section>
      ),
    },
    {
      key: "psi",
      node: (
        <Section
          title="PageSpeed Insights"
          icon={<IconGauge />}
          defaultOpen={false}
          headerAction={
            <CopyButton getText={() => formatPsiForClipboard(data)} />
          }
        >
          <PageSpeedInsightsBlock data={data} />
        </Section>
      ),
    },
    {
      key: "analysis",
      node: (
        <Section
          title="Analysis"
          icon={<IconLayers />}
          defaultOpen={false}
          headerAction={
            <CopyButton getText={() => formatBreakdownForClipboard(data)} />
          }
        >
          <BreakdownBlock data={data} />
        </Section>
      ),
    },
    // Technical Improvements sits above the two screenshot sections so
    // the image-heavy content lives at the very bottom of the report.
    {
      key: "tech",
      node: (
        <Section
          title="Technical Improvements"
          icon={<IconWrench />}
          defaultOpen={false}
          headerAction={
            <CopyButton getText={() => formatTechImprovementsForClipboard(data)} />
          }
        >
          <TechnicalImprovementsBlock data={data} />
        </Section>
      ),
    },
    // Above-the-Fold Screenshots is the last user-visible section.
    // The Full Page Screenshot section was removed from the UI — the
    // fullpage Microlink captures still run in /api/analyze and the
    // URLs are still attached to the response (data.desktopFullPageScreenshot /
    // data.mobileFullPageScreenshot), but they're only used as visual
    // context for the dimension prompts (notably the bottom-form CRO
    // check). They're no longer rendered as their own section.
    {
      key: "screenshots",
      node: (
        <Section
          title="Above-the-Fold Screenshots"
          icon={<IconEye />}
          defaultOpen={false}
          headerAction={
            <DownloadButton
              label="Download above-the-fold screenshots"
              files={[
                {
                  url: data.desktopScreenshot,
                  filename: `${screenshotFilenameStem(data)}-atf-desktop.webp`,
                },
                {
                  url: data.mobileScreenshot,
                  filename: `${screenshotFilenameStem(data)}-atf-mobile.webp`,
                },
              ]}
            />
          }
        >
          <ScreenshotsBlock data={data} />
        </Section>
      ),
    },
  ];

  // Stage trace inspector — only renders when /api/analyze was called
  // with ?debug=1. Captures the content at every pipeline phase plus
  // what was removed at each phase with reasons. Used for tuning, not
  // shown on normal runs.
  if (data.debugTrace) {
    sections.push({
      key: "stage-trace",
      node: (
        <Section
          title="Stage Trace (debug)"
          icon={<IconLayers />}
          defaultOpen={false}
        >
          <StageTraceBlock trace={data.debugTrace} />
        </Section>
      ),
    });
  }

  // Sequential reveal: each section slides in from the left ~500ms after
  // the previous one. Page scroll follows each new section in, then once
  // the cascade is done the page scrolls back up to the Overview.
  const [revealedIndex, setRevealedIndex] = useState(-1);
  const refs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setRevealedIndex(-1);

    function step(i: number) {
      if (cancelled) return;
      if (i >= sections.length) return;
      // Just reveal — never hijack the scroll. The user controls scrolling
      // themselves; if they want to scroll down to see the next section as
      // it animates in, they can.
      setRevealedIndex(i);
      timers.push(setTimeout(() => step(i + 1), 550));
    }

    // Tiny initial delay so the first section's transition runs cleanly.
    timers.push(setTimeout(() => step(0), 60));

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    // Re-run the cascade whenever a new report mounts in this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.url, data.analyzedAt]);

  return (
    <LightboxContext.Provider value={openLightbox}>
      <div className="space-y-5">
        {sections.map((s, i) => {
          const visible = i <= revealedIndex;
          return (
            <div
              key={s.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              style={{
                opacity: visible ? 1 : 0,
                transform: visible ? "translateX(0)" : "translateX(-40px)",
                transition: "opacity 500ms ease-out, transform 500ms ease-out",
              }}
            >
              {s.node}
            </div>
          );
        })}
      </div>
      {/* Single root-level overlay. Visibility is gated inside Lightbox
          itself by the `open` prop, so it's cheap to leave mounted. */}
      <Lightbox
        open={lightbox !== null}
        src={lightbox?.src}
        alt={lightbox?.alt}
        mode={lightbox?.mode ?? "atf"}
        onClose={closeLightbox}
      />
    </LightboxContext.Provider>
  );
}

/**
 * Header action for a Section. Renders a small grey "two-pages" copy icon
 * that writes a clean text version of the section to the clipboard. Briefly
 * swaps to a check icon as confirmation. Stops the click from toggling the
 * surrounding <details>.
 */
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy section to clipboard"
      title="Copy"
      onClick={(e) => {
        // <summary> children toggle the parent <details> on click. Stop both
        // so the section stays in its current open/closed state.
        e.preventDefault();
        e.stopPropagation();
        const text = getText();
        if (!text) return;
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })
          .catch(() => {
            // Some browsers block clipboard writes outside secure contexts.
            // Fallback to a textarea + execCommand.
            try {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.style.position = "fixed";
              ta.style.left = "-9999px";
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            } catch {
              /* give up silently */
            }
          });
      }}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition hover:bg-bg hover:text-ink"
    >
      {copied ? <IconCheck className="h-4 w-4 text-accent" /> : <IconCopy />}
    </button>
  );
}

/**
 * Header action for a screenshot Section. Same visual treatment as
 * CopyButton (small grey icon, hover darkens, briefly swaps to a check
 * after action). Clicking it downloads the high-quality WebP files
 * (desktop + mobile) to the user's computer.
 *
 * Implementation note: rather than fetch Microlink's CDN URL directly
 * from the browser (which fails silently when CORS headers are missing
 * and won't honour the `download` attribute on cross-origin anchors),
 * we route through `/api/download` — a same-origin server proxy that
 * fetches the bytes server-side and streams them back with the right
 * Content-Disposition: attachment header. PSI base64 fallbacks are
 * still downloaded directly via a Blob URL since they're inline.
 */
function DownloadButton({
  files,
  label,
}: {
  /** One entry per file to download. `url` is the Microlink WebP URL
   *  (or PSI base64 data URL as a fallback). `filename` is what the
   *  saved file should be named locally. */
  files: Array<{ url: string | undefined; filename: string }>;
  /** Accessible label / tooltip for the button. */
  label: string;
}) {
  const [done, setDone] = useState(false);
  const usable = files.filter(
    (f): f is { url: string; filename: string } => typeof f.url === "string" && f.url.length > 0,
  );
  if (usable.length === 0) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // Stop the click from toggling the surrounding <details>.
        e.preventDefault();
        e.stopPropagation();
        downloadFiles(usable);
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      }}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition hover:bg-bg hover:text-ink"
    >
      {done ? <IconCheck className="h-4 w-4 text-accent" /> : <IconDownload />}
    </button>
  );
}

/** Trigger a browser download for each file. Cross-origin URLs go via
 *  our /api/download proxy so the browser saves the bytes instead of
 *  opening them inline; data URLs (PSI fallbacks) get downloaded
 *  directly with a temporary anchor + the download attribute. */
function downloadFiles(files: Array<{ url: string; filename: string }>): void {
  for (const f of files) {
    let href: string;
    if (f.url.startsWith("data:")) {
      // PSI base64 fallback — same-origin (data URL), the download
      // attribute works as-is.
      href = f.url;
    } else {
      // Cross-origin Microlink URL — go through our same-origin proxy
      // so the response carries Content-Disposition: attachment.
      const proxy = new URL("/api/download", window.location.origin);
      proxy.searchParams.set("url", f.url);
      proxy.searchParams.set("filename", f.filename);
      href = proxy.toString();
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = f.filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

/** Format a runtime in milliseconds for the Overview's "Runtime" row.
 *  Under a minute: one-decimal seconds (e.g. "47.3s"). One minute or
 *  more: minutes + whole seconds (e.g. "2m 13s"). Skips the seconds
 *  part when it would round to 0 ("3m"). */
function formatRuntime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Build a filesystem-safe filename stem from the report. Used to name
 *  the WebP downloads (e.g. `revenuagency-io-atf-desktop.webp`). Falls
 *  back to "screenshot" when the displayName produces only stripped
 *  characters. */
function screenshotFilenameStem(data: AnalyzeResponse): string {
  const raw = (displayName(data) || data.url || "").toLowerCase();
  const cleaned = raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "screenshot";
}

/** Standard report header — name, URL, analysed date — used by every
 *  copy-to-clipboard function so the recipient knows what they're
 *  looking at without scrolling. */
function clipboardHeader(data: AnalyzeResponse, sectionTitle: string): string {
  return (
    `${sectionTitle} — ${displayName(data)}\n` +
    `${data.url}\n` +
    `${new Date(data.analyzedAt).toLocaleString()}\n` +
    `\n`
  );
}

/** Overview section clipboard format: overall score, narrative summary,
 *  and a clean list of the six dimension scores. */
function formatOverviewForClipboard(data: AnalyzeResponse): string {
  const order: CheckKey[] = [
    "speed",
    "aboveTheFold",
    "cro",
    "content",
    "mobile",
    "digestibility",
  ];
  const summary = overallSummary(data).trim();
  const dims = order
    .map((k) => {
      const c = data.checks[k];
      return `- ${CHECK_META[k].title}: ${c.score}/100`;
    })
    .join("\n");
  return (
    clipboardHeader(data, "Overview") +
    `Overall: ${data.overall}/100\n` +
    `\n` +
    `Summary:\n${summary}\n` +
    `\n` +
    `Dimension scores:\n${dims}\n`
  );
}

/** Analysis section clipboard format: each of the six dimension cards
 *  with its score, headline, and bullet notes laid out like an outline. */
function formatBreakdownForClipboard(data: AnalyzeResponse): string {
  const order: CheckKey[] = [
    "speed",
    "aboveTheFold",
    "cro",
    "content",
    "mobile",
    "digestibility",
  ];
  const body = order
    .map((k, i) => {
      const c = data.checks[k] as CheckResult;
      const title = `${i + 1}. ${CHECK_META[k].title} — ${c.score}/100`;
      const headline = c.headline ? `\n   ${c.headline}` : "";
      const notes = c.notes
        .map((n) => `   - ${n}`)
        .join("\n");
      return title + headline + (notes ? `\n${notes}` : "");
    })
    .join("\n\n");
  return clipboardHeader(data, "Analysis") + body + "\n";
}

/** PageSpeed Insights section clipboard format: per-strategy category
 *  scores + key timing metrics, followed by the auto-generated summary
 *  bullets. */
function formatPsiForClipboard(data: AnalyzeResponse): string {
  const desktop = data.pageSpeedInsights?.desktop;
  const mobile = data.pageSpeedInsights?.mobile;
  if (!desktop && !mobile) return "";

  // Expand the short chart titles to the full Lighthouse names for
  // clipboard so the copied text is self-explanatory outside the UI.
  const METRIC_LONG_TITLES: Record<string, string> = {
    performance: "Performance",
    accessibility: "Accessibility",
    bestPractices: "Best Practices",
    seo: "SEO",
    speedIndex: "Speed Index",
    lcp: "Largest Contentful Paint",
    fcp: "First Contentful Paint",
    cls: "Cumulative Layout Shift",
    tbt: "Total Blocking Time",
    pageWeight: "Page Weight",
  };

  const formatStrategy = (deviceLabel: string, b: PsiBreakdown): string => {
    // Mirror the 10 bar-chart graphs on screen (CHART_METRIC_CONFIGS).
    // Each line shows the metric's full title + the strategy's value
    // using the same formatter the chart uses, so the clipboard stays
    // in sync with the UI.
    const metrics = CHART_METRIC_CONFIGS.map((m) => {
      const v = m.getValue(b);
      const longTitle = METRIC_LONG_TITLES[m.key] ?? m.title;
      return `- ${longTitle}: ${m.formatValueLabel(v)}`;
    }).join("\n");
    return `${deviceLabel}:\n${metrics}`;
  };

  const blocks: string[] = [];
  if (desktop) blocks.push(formatStrategy("Desktop", desktop));
  if (mobile) blocks.push(formatStrategy("Mobile", mobile));

  const summaryBullets = computePsiSummaryBullets(desktop, mobile);
  const summary =
    summaryBullets.length > 0
      ? `\nSummary:\n${summaryBullets.map((b) => `- ${b}`).join("\n")}\n`
      : "";

  return clipboardHeader(data, "PageSpeed Insights") + blocks.join("\n\n") + summary;
}

function formatTakeawaysForClipboard(data: AnalyzeResponse): string {
  // Up to 6 items: 5 from Claude + the deterministic Technical
  // Improvements pointer always appended last.
  const items = (data.keyTakeaways ?? []).slice(0, 6);
  if (items.length === 0) return "";
  const header =
    `Key Recommendations — ${displayName(data)}\n` +
    `${data.url}\n` +
    `${new Date(data.analyzedAt).toLocaleString()}\n` +
    `\n`;
  const body = items
    .map((it, i) => {
      const text = typeof it === "string" ? it : it.text;
      // Use displayLabel when set (e.g. "Technical:") otherwise fall
      // back to the category title.
      const label =
        typeof it === "string"
          ? ""
          : `${it.displayLabel ?? CHECK_META[it.category].title}: `;
      return `${i + 1}. ${label}${text}`;
    })
    .join("\n");
  return header + body + "\n";
}

function formatTechImprovementsForClipboard(data: AnalyzeResponse): string {
  const items = data.technicalImprovements ?? [];
  if (items.length === 0) return "";
  const header =
    `Technical Improvements — ${displayName(data)}\n` +
    `${data.url}\n` +
    `${new Date(data.analyzedAt).toLocaleString()}\n` +
    `\n`;
  const body = items
    .map((it, i) => {
      const savings = formatSavings(it);
      const source =
        it.source === "both"
          ? "Desktop + Mobile"
          : it.source === "mobile"
          ? "Mobile"
          : "Desktop";
      const top =
        `${i + 1}. ${it.title}` +
        (savings ? `  —  ${savings}` : "") +
        `  (${source})`;
      const desc = it.description ? `\n   ${it.description}` : "";
      const dv = it.displayValue ? `\n   ${it.displayValue}` : "";
      const detailRows = formatItemsForClipboard(it);
      const items = detailRows ? `\n${detailRows}` : "";
      return top + desc + dv + items;
    })
    .join("\n\n");
  return header + body + "\n";
}

/**
 * Turn a TechnicalImprovement's `items` array into indented "   - " lines
 * for the clipboard copy. Picks out url + the most useful numeric field.
 */
function formatItemsForClipboard(it: TechnicalImprovement): string {
  if (!it.items || it.items.length === 0) return "";
  const lines: string[] = [];
  for (const row of it.items) {
    const label = pickItemLabel(row);
    const value = pickItemValue(row);
    if (!label && !value) continue;
    if (label && value) lines.push(`   - ${label}  (${value})`);
    else if (label) lines.push(`   - ${label}`);
    else if (value) lines.push(`   - ${value}`);
  }
  return lines.join("\n");
}

export function OverviewBlock({
  data,
}: {
  data: AnalyzeResponse;
  onRerun?: () => void;
  rerunning?: boolean;
}) {
  const order: CheckKey[] = [
    "speed",
    "aboveTheFold",
    "cro",
    "content",
    "mobile",
    "digestibility",
  ];
  return (
    <div>
      {/* Four-column layout on desktop: ring | URL+Analysed | Summary |
          small desktop above-the-fold thumbnail. Stacks vertically on
          mobile. The thumbnail is intentionally compact (~200px wide)
          so it adds a visual anchor without dominating the row. */}
      <div className="flex flex-col items-center gap-8 md:grid md:grid-cols-[auto_1fr_1fr_auto] md:items-start md:gap-10">
        <div className="flex justify-center">
          <ScoreRing score={data.overall} size={160} label="OVERALL" />
        </div>
        <div className="min-w-0 w-full">
          <MetaRow
            label="URL"
            value={
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all hover:text-accent"
              >
                {data.url}
              </a>
            }
          />
          <div className="mt-6">
            <MetaRow
              label="Analysed"
              value={new Date(data.analyzedAt).toLocaleString()}
            />
          </div>
          {typeof data.runtimeMs === "number" && (
            <div className="mt-6">
              <MetaRow
                label="Runtime"
                value={formatRuntime(data.runtimeMs)}
              />
            </div>
          )}
        </div>
        <div className="min-w-0 w-full">
          <div
            className="text-[11px] font-bold uppercase text-ink-soft"
            style={{ letterSpacing: "0.16em" }}
          >
            Summary
          </div>
          <p className="mt-3 text-[15px] font-medium leading-[1.65] text-ink">
            {overallSummary(data)}
          </p>
        </div>
        {data.desktopScreenshot && (
          <OverviewSnapshot data={data} />
        )}
      </div>

      <div className="mt-10 grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
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
                {/* CHECK_META icons are pre-instantiated with a default size
                    that doesn't fit cleanly inside h-7 w-7. Clone to force
                    h-4 w-4 so the SVG itself is the flex item being
                    centred (not a too-small wrapper that lets the SVG
                    overflow off-axis). */}
                {isValidElement(CHECK_META[k].icon)
                  ? cloneElement(
                      CHECK_META[k].icon as React.ReactElement<{ className?: string }>,
                      { className: "h-4 w-4" },
                    )
                  : CHECK_META[k].icon}
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

/**
 * Small desktop above-the-fold thumbnail shown in the Overview row.
 * Clicking it opens the lightbox at the highest-quality WebP version we
 * have for the page (Microlink AtF capture when available; PSI base64 as
 * fallback, which is the same image source the thumbnail uses).
 */
function OverviewSnapshot({ data }: { data: AnalyzeResponse }) {
  const open = useLightboxOpen();
  const src = data.desktopScreenshot;
  if (!src) return null;
  return (
    <div className="w-[200px] flex-shrink-0">
      <button
        type="button"
        onClick={() => open?.({ src, mode: "atf", alt: "Desktop above-the-fold" })}
        className="block w-full overflow-hidden rounded-card border border-beige-line bg-card p-0 transition hover:border-accent"
        style={{ cursor: "zoom-in" }}
        aria-label="Open desktop above-the-fold screenshot"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Desktop above-the-fold preview"
          className="block w-full h-auto"
        />
      </button>
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="text-[11px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        {label}
      </div>
      <div className="mt-3 text-[15px] font-semibold tracking-tight text-ink break-words">
        {value}
      </div>
    </div>
  );
}

function BreakdownBlock({ data }: { data: AnalyzeResponse }) {
  const order: CheckKey[] = [
    "speed",
    "aboveTheFold",
    "cro",
    "content",
    "mobile",
    "digestibility",
  ];

  // Carousel state. We track whether arrows should be enabled and disable
  // them at the edges so the user can't scroll past the first/last card.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  // Update arrow state on scroll. Native scroll handles touch swipe and
  // the snap-mandatory CSS keeps the cards aligned on release. We just
  // need to know where we are so we can grey out arrows at the edges.
  function recomputeEdges() {
    const el = scrollerRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  // Recompute once on mount + whenever the container resizes (e.g. window
  // resize). ResizeObserver fires whenever the carousel changes size, so
  // moving from desktop to a narrower viewport correctly re-evaluates
  // whether the "end" state should still be active.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    recomputeEdges();
    const ro = new ResizeObserver(() => recomputeEdges());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Arrow click handler. Scrolls by one full visible page so the user
  // always sees three fresh cards on lg+, two on sm, one on mobile.
  function scrollByPage(dir: -1 | 1) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
  }

  // Mouse drag implementation. Touch already works natively via
  // overflow-x-auto, but desktop users expect grab-and-drag. The
  // carousel scrolls freely — no snap — so the row stays exactly where
  // the user releases it. Arrow buttons still page-jump by clientWidth.
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0 });
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only react to primary mouse / pen / touch.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = scrollerRef.current;
    if (!el) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startScrollLeft: el.scrollLeft,
    };
    el.setPointerCapture(e.pointerId);
    el.style.cursor = "grabbing";
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current.active) return;
    const el = scrollerRef.current;
    if (!el) return;
    // Sensitivity multiplier: cursor movement amplified so the carousel
    // tracks ahead of the cursor. 1:1 felt sluggish; ~1.6x lands in the
    // sweet spot where the drag feels responsive without being twitchy.
    const DRAG_SENSITIVITY = 1.6;
    const dx = (e.clientX - dragRef.current.startX) * DRAG_SENSITIVITY;
    el.scrollLeft = dragRef.current.startScrollLeft - dx;
    e.preventDefault();
  }
  function endDrag(e?: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const el = scrollerRef.current;
    if (!el) return;
    if (e) el.releasePointerCapture(e.pointerId);
    el.style.cursor = "";
  }

  return (
    <div className="relative">
      {/* Left arrow. Positioned outside the carousel track at md+ so it
          doesn't overlap the first card; on mobile we move it inside the
          edge so it's still tappable without overflow. */}
      <CarouselArrow
        direction="left"
        disabled={atStart}
        onClick={() => scrollByPage(-1)}
      />
      <CarouselArrow
        direction="right"
        disabled={atEnd}
        onClick={() => scrollByPage(1)}
      />

      <div
        ref={scrollerRef}
        onScroll={recomputeEdges}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // The cursor flips to grabbing while dragging via inline style; the
        // base cursor signals the card row is draggable. No scroll-snap:
        // the row scrolls freely so the user can park it anywhere.
        // pdf-breakdown-carousel — when body.pdf-printing is set, this
        // row collapses to a static grid so the PDF shows all 6 cards.
        className="pdf-breakdown-carousel flex gap-4 overflow-x-auto cursor-grab select-none scroll-smooth pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
      >
        {order.map((k) => (
          <div
            key={k}
            // Cards are 30% wider than the "exactly N per page" sizing
            // so the carousel scrolls instead of fitting evenly. Mobile
            // stays full-width (one per screen). sm and lg multiply the
            // even-fit width by 1.3 — same gap math, just stretched
            // cards. flex-shrink-0 stops them squashing when the row
            // overflows.
            className="flex-shrink-0 w-full sm:w-[calc((100%-1rem)/2*1.3)] lg:w-[calc((100%-2rem)/3*1.3)]"
          >
            <ScoreCard
              title={CHECK_META[k].title}
              icon={CHECK_META[k].icon}
              result={data.checks[k] as CheckResult}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Round arrow button for the Breakdown carousel. Positioned absolutely on
 * the sides of the carousel; greyed out when at the start/end of the row.
 */
function CarouselArrow({
  direction,
  disabled,
  onClick,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={direction === "left" ? "Previous cards" : "Next cards"}
      onClick={onClick}
      disabled={disabled}
      // Sits on the vertical centre line of the carousel, just outside the
      // card edge so it doesn't cover content. Slightly inset on small
      // screens so it stays inside the viewport.
      className={
        "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-beige-line bg-card shadow-card transition " +
        (disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:-translate-y-[calc(50%+1px)] hover:shadow-cardHover") +
        " " +
        (direction === "left"
          ? "-left-3 sm:-left-5"
          : "-right-3 sm:-right-5")
      }
    >
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-ink"
        style={{ transform: direction === "left" ? "rotate(180deg)" : undefined }}
      >
        <polyline points="6 3 11 8 6 13" />
      </svg>
    </button>
  );
}

function KeyTakeawaysBlock({ data }: { data: AnalyzeResponse }) {
  // Up to 6 items: 5 from Claude (after image-format prepend cap) + the
  // deterministic Technical Improvements pointer always appended last.
  const items = (data.keyTakeaways ?? []).slice(0, 6);
  if (items.length === 0) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        No recommendations were returned for this run.
      </p>
    );
  }
  return (
    <ol className="m-0 flex flex-col gap-2 p-0 list-none">
      {items.map((item, i) => {
        // Backward compat: older saved reports have plain string takeaways.
        const text = typeof item === "string" ? item : item.text;
        const category =
          typeof item === "string" ? undefined : item.category;
        // displayLabel overrides the category title (e.g. "Technical:")
        // for synthetic items appended outside the scored-dimension
        // set. Falls back to the category title otherwise.
        const displayLabel =
          typeof item === "string" ? undefined : item.displayLabel;
        const tag = displayLabel
          ? displayLabel
          : category
          ? CHECK_META[category].title
          : null;
        return (
          <li
            key={i}
            className="flex items-center gap-3 rounded-card border border-beige-line bg-bg/40 px-4 py-2.5"
          >
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-ink">
              {tag && (
                <span className="font-bold text-ink">
                  {tag}:
                </span>
              )}{" "}
              {text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Technical Improvements.
 *
 * The list of Lighthouse opportunities + diagnostics returned by PageSpeed
 * Insights, merged across desktop and mobile and ranked by impact. Each row
 * shows the title, the estimated savings (if Lighthouse provides them),
 * which device the issue appears on, and Lighthouse's own description so
 * the engineer reading the report doesn't need to look anything up.
 */
function TechnicalImprovementsBlock({ data }: { data: AnalyzeResponse }) {
  const items = data.technicalImprovements ?? [];
  if (items.length === 0) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        No technical improvements were flagged by Lighthouse for this URL.
        Performance is solid.
      </p>
    );
  }
  return (
    <ul className="m-0 flex flex-col gap-3 p-0 list-none">
      {items.map((it) => (
        <TechImprovementRow key={it.id} it={it} />
      ))}
    </ul>
  );
}

/**
 * One expandable technical-improvement row. The collapsed view shows the
 * title, savings, and which device(s) the issue applies to. Clicking the
 * row reveals Lighthouse's full description, the displayValue, and the
 * per-resource breakdown table when Lighthouse provides one (this mirrors
 * the click-to-expand behaviour inside Google's own PSI UI).
 */
function TechImprovementRow({ it }: { it: TechnicalImprovement }) {
  const savings = formatSavings(it);
  const tagClass = sourceTagClass(it.source);
  const tagLabel =
    it.source === "both"
      ? "DESKTOP + MOBILE"
      : it.source === "mobile"
      ? "MOBILE"
      : "DESKTOP";
  const hasDetails =
    Boolean(it.description) ||
    Boolean(it.displayValue) ||
    (it.items?.length ?? 0) > 0;

  return (
    <li className="overflow-hidden rounded-card border border-beige-line bg-bg/40">
      <details className="group">
        <summary
          className={
            "flex list-none items-center gap-3 px-4 py-3 " +
            (hasDetails ? "cursor-pointer" : "cursor-default")
          }
          style={{ outline: "none" }}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="m-0 text-[14px] font-semibold tracking-tight text-ink">
              {it.title}
            </h3>
            <div className="flex flex-shrink-0 items-center gap-2">
              {savings && (
                <span className="text-[12px] font-semibold text-accent-dark">
                  {savings}
                </span>
              )}
              <span
                className={
                  "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase " +
                  tagClass
                }
                style={{ letterSpacing: "0.08em" }}
              >
                {tagLabel}
              </span>
            </div>
          </div>
          {hasDetails && (
            <IconChevron className="h-4 w-4 flex-shrink-0 text-ink-soft transition-transform group-open:rotate-180" />
          )}
        </summary>
        {hasDetails && (
          <div className="border-t border-beige-line bg-card px-4 py-3">
            {it.description && (
              <p className="m-0 text-[13px] font-medium leading-[1.55] text-ink-soft">
                {it.description}
              </p>
            )}
            {it.displayValue && (
              <p className="mt-1.5 text-[12px] font-semibold tracking-tight text-ink">
                {it.displayValue}
              </p>
            )}
            {it.items && it.items.length > 0 && (
              <TechImprovementItems it={it} />
            )}
          </div>
        )}
      </details>
    </li>
  );
}

function TechImprovementItems({ it }: { it: TechnicalImprovement }) {
  if (!it.items) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1.5 border-t border-beige-line/60 pt-3 list-none p-0">
      {it.items.map((row, i) => {
        const label = pickItemLabel(row);
        const value = pickItemValue(row);
        if (!label && !value) return null;
        return (
          <li
            key={i}
            className="flex items-baseline justify-between gap-3 text-[12px] font-medium text-ink-soft"
          >
            <span className="min-w-0 flex-1 truncate" title={label || undefined}>
              {label || "—"}
            </span>
            {value && (
              <span className="flex-shrink-0 font-semibold tabular-nums text-ink">
                {value}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Pick the most readable text label from a Lighthouse details row. Almost
 * every audit row has one of: url, label, groupLabel, statistic, source.
 */
function pickItemLabel(
  row: Record<string, string | number | boolean | undefined | null>,
): string {
  const candidates = ["url", "label", "groupLabel", "statistic", "source", "node", "selector", "name"];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/**
 * Pick the most useful numeric reading from a Lighthouse details row and
 * format it as "1.2 s", "42 KB", "320 ms", etc. We check the common keys
 * Lighthouse uses across audit types.
 */
function pickItemValue(
  row: Record<string, string | number | boolean | undefined | null>,
): string {
  const wastedMs = row.wastedMs;
  if (typeof wastedMs === "number" && wastedMs > 0) {
    return wastedMs >= 1000
      ? `${(wastedMs / 1000).toFixed(2)} s`
      : `${Math.round(wastedMs)} ms`;
  }
  const wastedBytes = row.wastedBytes;
  if (typeof wastedBytes === "number" && wastedBytes > 0) {
    return formatBytes(wastedBytes);
  }
  const totalBytes = row.totalBytes;
  if (typeof totalBytes === "number" && totalBytes > 0) {
    return formatBytes(totalBytes);
  }
  const duration = row.duration;
  if (typeof duration === "number" && duration > 0) {
    return duration >= 1000
      ? `${(duration / 1000).toFixed(2)} s`
      : `${Math.round(duration)} ms`;
  }
  const transferSize = row.transferSize;
  if (typeof transferSize === "number" && transferSize > 0) {
    return formatBytes(transferSize);
  }
  return "";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatSavings(it: {
  overallSavingsMs?: number;
  overallSavingsBytes?: number;
  displayValue?: string;
}): string | undefined {
  if (it.overallSavingsMs && it.overallSavingsMs > 0) {
    const s = it.overallSavingsMs / 1000;
    return s >= 1
      ? `Save ${s.toFixed(1)} s`
      : `Save ${Math.round(it.overallSavingsMs)} ms`;
  }
  if (it.overallSavingsBytes && it.overallSavingsBytes > 0) {
    const kb = it.overallSavingsBytes / 1024;
    return kb >= 1024
      ? `Save ${(kb / 1024).toFixed(1)} MB`
      : `Save ${Math.round(kb)} KB`;
  }
  return it.displayValue || undefined;
}

function sourceTagClass(source: "desktop" | "mobile" | "both" | undefined): string {
  if (source === "both") return "bg-accent text-white";
  if (source === "mobile") return "bg-accent-soft text-accent-dark";
  return "bg-beige-line text-ink-soft";
}

/* ---------- PageSpeed Insights section ---------------------------------- */

/**
 * Mirrors PSI's own category breakdown: four category scores per strategy
 * (Performance / Accessibility / Best Practices / SEO), the headline Core
 * Web Vitals, a horizontal bar comparing desktop vs mobile across the four
 * categories, and a short bulleted summary so nothing from the API run
 * gets buried.
 */
function PageSpeedInsightsBlock({ data }: { data: AnalyzeResponse }) {
  const desktop = data.pageSpeedInsights?.desktop;
  const mobile = data.pageSpeedInsights?.mobile;
  if (!desktop && !mobile) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        PageSpeed Insights didn&apos;t return any data for this run.
      </p>
    );
  }
  return (
    <div className="space-y-8">
      {/* TEN bar-chart graphs in two rows of five, each comparing
          Desktop vs Mobile. Row 1 is the 4 Lighthouse category scores
          plus Speed Index; row 2 is the Core Web Vitals + Page Weight
          (Largest Paint, First Paint, Layout Shift, Blocking Time,
          Page Weight). All cards share the same chart layout. The
          grid sits directly inside the PSI section — no wrapper. */}
      <PsiMetricGrid desktop={desktop} mobile={mobile} />

      {/* Numbered summary — what stood out across the metrics. */}
      <PsiSummary desktop={desktop} mobile={mobile} />
    </div>
  );
}

interface CategoryRow {
  key: "performance" | "accessibility" | "bestPractices" | "seo";
  label: string;
}
const PSI_CATEGORIES: CategoryRow[] = [
  { key: "performance", label: "Performance" },
  { key: "accessibility", label: "Accessibility" },
  { key: "bestPractices", label: "Best Practices" },
  { key: "seo", label: "SEO" },
];

function catScore(b: PsiBreakdown | undefined, k: CategoryRow["key"]) {
  if (!b) return null;
  if (k === "performance") return b.performanceScore;
  if (k === "accessibility") return b.accessibilityScore;
  if (k === "bestPractices") return b.bestPracticesScore;
  return b.seoScore;
}

/** Maximum value used for the Speed Index chart's y-axis. Anything
 *  beyond this clamps to full height. */
const SPEED_INDEX_MAX_SECS = 10;

function speedIndexBandColor(secs: number): string {
  if (secs <= 3.4) return scoreColor(95); // green
  if (secs <= 5.8) return scoreColor(60); // orange
  return scoreColor(30); // red
}

/**
 * Configuration for one PSI bar-chart card. We have five — Performance,
 * Accessibility, Best Practices, SEO (all 0-100 score bars) plus Speed
 * Index (0-10s timing bar). Each config supplies the title shown
 * top-left, the icon shown top-right, the y-axis scale, and getters /
 * formatters for the underlying value.
 */
interface PsiChartMetricConfig {
  key: string;
  title: string;
  icon: React.ReactNode;
  yMax: number;
  yTickFormat: (v: number) => string;
  getValue: (b: PsiBreakdown | undefined) => number | null;
  formatValueLabel: (v: number | null) => string;
  getColor: (v: number | null) => string;
}

// Order: Speed Index, Largest Paint, First Paint, Page Weight,
// Blocking Time first (row 1 = the perceived-speed / impact metrics);
// then Layout Shift + the four Lighthouse category scores (row 2).
const CHART_METRIC_CONFIGS: PsiChartMetricConfig[] = [
  {
    key: "speedIndex",
    title: "Speed Index",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l3 2" />
        <path d="M9 2h6" />
      </svg>
    ),
    yMax: SPEED_INDEX_MAX_SECS,
    // Tick labels in seconds — keep them short so they fit the narrow y-axis.
    yTickFormat: (v) => `${v % 1 === 0 ? v : v.toFixed(1)}s`,
    // Convert PSI ms -> seconds for plotting. Speed Index is "smaller is
    // better" so the bar height tracks seconds directly (a fast page
    // produces a short, green bar).
    getValue: (b) =>
      b?.speedIndexMs == null ? null : b.speedIndexMs / 1000,
    formatValueLabel: (v) => (v == null ? "—" : `${v.toFixed(2)}s`),
    getColor: (v) => (v == null ? "#c4c0b6" : speedIndexBandColor(v)),
  },
  {
    // First Contentful Paint — time to first piece of content appearing.
    // Good ≤ 1.8s, poor > 3s (Lighthouse).
    key: "fcp",
    title: "First Paint",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
      </svg>
    ),
    yMax: 6,
    yTickFormat: (v) => (v === 0 ? "0" : `${v % 1 === 0 ? v : v.toFixed(1)}s`),
    getValue: (b) => (b?.fcpMs == null ? null : b.fcpMs / 1000),
    formatValueLabel: (v) => (v == null ? "—" : `${v.toFixed(2)}s`),
    getColor: (v) =>
      v == null
        ? "#c4c0b6"
        : v <= 1.8
        ? scoreColor(95)
        : v > 3
        ? scoreColor(30)
        : scoreColor(60),
  },
  {
    // Largest Contentful Paint — time to paint the biggest visible
    // element. Good ≤ 2.5s, poor > 4s (Core Web Vital).
    key: "lcp",
    title: "Largest Paint",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="11" r="1.5" />
        <path d="M3 17l5-5 4 4 3-3 6 6" />
      </svg>
    ),
    yMax: 12,
    yTickFormat: (v) => (v === 0 ? "0" : `${Math.round(v)}s`),
    getValue: (b) => (b?.lcpMs == null ? null : b.lcpMs / 1000),
    formatValueLabel: (v) => (v == null ? "—" : `${v.toFixed(2)}s`),
    getColor: (v) =>
      v == null
        ? "#c4c0b6"
        : v <= 2.5
        ? scoreColor(95)
        : v > 4
        ? scoreColor(30)
        : scoreColor(60),
  },
  {
    // Page Weight — total bytes transferred. Thresholds are pragmatic
    // landing-page targets, not a Lighthouse band. Good ≤ 1.5MB,
    // poor > 3MB.
    key: "pageWeight",
    title: "Page Weight",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M6 2h12l2 4-8 16L4 6z" />
        <path d="M9 6l3 4 3-4" />
      </svg>
    ),
    yMax: 10 * 1024 * 1024, // 10MB in bytes
    yTickFormat: (v) => (v === 0 ? "0" : `${(v / 1024 / 1024).toFixed(0)}MB`),
    getValue: (b) => (b?.totalByteWeight == null ? null : b.totalByteWeight),
    formatValueLabel: (v) =>
      v == null ? "—" : `${(v / 1024 / 1024).toFixed(1)}MB`,
    getColor: (v) =>
      v == null
        ? "#c4c0b6"
        : v <= 1.5 * 1024 * 1024
        ? scoreColor(95)
        : v > 3 * 1024 * 1024
        ? scoreColor(30)
        : scoreColor(60),
  },
  {
    // Total Blocking Time — main-thread blocking (lab proxy for INP).
    // Good ≤ 200ms, poor > 600ms (Lighthouse).
    key: "tbt",
    title: "Blocking Time",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
    ),
    yMax: 2000, // milliseconds
    yTickFormat: (v) => (v === 0 ? "0" : `${(v / 1000).toFixed(1)}s`),
    getValue: (b) => (b?.tbtMs == null ? null : b.tbtMs),
    formatValueLabel: (v) =>
      v == null
        ? "—"
        : v >= 1000
        ? `${(v / 1000).toFixed(2)}s`
        : `${Math.round(v)}ms`,
    getColor: (v) =>
      v == null
        ? "#c4c0b6"
        : v <= 200
        ? scoreColor(95)
        : v > 600
        ? scoreColor(30)
        : scoreColor(60),
  },
  {
    // Cumulative Layout Shift — unitless score of visual stability.
    // Good ≤ 0.1, poor > 0.25 (Core Web Vital).
    key: "cls",
    title: "Layout Shift",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="3" y="3" width="10" height="10" rx="1" />
        <rect x="11" y="11" width="10" height="10" rx="1" />
      </svg>
    ),
    yMax: 0.4,
    yTickFormat: (v) => (v === 0 ? "0" : v.toFixed(2)),
    getValue: (b) => (b?.cls == null ? null : b.cls),
    formatValueLabel: (v) => (v == null ? "—" : v.toFixed(2)),
    getColor: (v) =>
      v == null
        ? "#c4c0b6"
        : v <= 0.1
        ? scoreColor(95)
        : v > 0.25
        ? scoreColor(30)
        : scoreColor(60),
  },
  {
    key: "performance",
    title: "Performance",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
      </svg>
    ),
    yMax: 100,
    yTickFormat: (v) => String(Math.round(v)),
    getValue: (b) => b?.performanceScore ?? null,
    formatValueLabel: (v) => (v == null ? "—" : String(v)),
    getColor: (v) => (v == null ? "#c4c0b6" : scoreColor(v)),
  },
  {
    key: "accessibility",
    title: "Accessibility",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <circle cx="12" cy="4" r="2" />
        <path d="M19 13a7 7 0 1 1-14 0" />
        <path d="M12 6v6l4 8" />
        <path d="M12 12l-4 8" />
      </svg>
    ),
    yMax: 100,
    yTickFormat: (v) => String(Math.round(v)),
    getValue: (b) => b?.accessibilityScore ?? null,
    formatValueLabel: (v) => (v == null ? "—" : String(v)),
    getColor: (v) => (v == null ? "#c4c0b6" : scoreColor(v)),
  },
  {
    key: "bestPractices",
    title: "Best Practices",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M12 2L4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
    yMax: 100,
    yTickFormat: (v) => String(Math.round(v)),
    getValue: (b) => b?.bestPracticesScore ?? null,
    formatValueLabel: (v) => (v == null ? "—" : String(v)),
    getColor: (v) => (v == null ? "#c4c0b6" : scoreColor(v)),
  },
  {
    key: "seo",
    title: "SEO",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-5-5" />
      </svg>
    ),
    yMax: 100,
    yTickFormat: (v) => String(Math.round(v)),
    getValue: (b) => b?.seoScore ?? null,
    formatValueLabel: (v) => (v == null ? "—" : String(v)),
    getColor: (v) => (v == null ? "#c4c0b6" : scoreColor(v)),
  },
];

/**
 * The grid of 10 bar-chart cards rendered directly in the PSI section,
 * no surrounding wrapper. Two rows of five on desktop. Each card
 * compares Desktop vs Mobile for one metric: Performance,
 * Accessibility, Best Practices, SEO, Speed Index, Largest Paint,
 * First Paint, Layout Shift, Blocking Time, Page Weight.
 */
function PsiMetricGrid({
  desktop,
  mobile,
}: {
  desktop?: PsiBreakdown;
  mobile?: PsiBreakdown;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {CHART_METRIC_CONFIGS.map((cfg) => (
        <PsiBarChartCard
          key={cfg.key}
          config={cfg}
          desktop={desktop}
          mobile={mobile}
        />
      ))}
    </div>
  );
}

/**
 * One PSI bar-chart card. Layout matches Joe's reference design:
 *
 *   - Title bold + left-aligned at top-left.
 *   - Small metric icon top-right.
 *   - Y-axis with 5 tick labels on the left (e.g. 100 / 75 / 50 / 25 / 0
 *     for score charts; 10s / 7.5s / 5s / 2.5s / 0 for Speed Index).
 *   - Faint dashed horizontal grid lines aligned to the y-ticks.
 *   - Two bars side by side (Desktop full saturation, Mobile 50% alpha).
 *     Each bar has a faint full-height "track" behind it showing the
 *     full possible range, plus the filled portion in the score-band
 *     colour.
 *   - X-axis labels (Desktop / Mobile) under the bars.
 *
 * Value labels sit above the top of each filled bar so the user reads
 * the exact number without doing y-axis arithmetic.
 */
function PsiBarChartCard({
  config,
  desktop,
  mobile,
}: {
  config: PsiChartMetricConfig;
  desktop?: PsiBreakdown;
  mobile?: PsiBreakdown;
}) {
  // Height of the bar drawing area. Total card height = this + room
  // for the title row + room for value labels above the bars + room
  // for x-axis labels below the bars.
  const CHART_HEIGHT = 150;
  const VALUE_LABEL_GAP = 18; // px of space above the chart for the value labels
  // Five evenly-spaced y-axis ticks: max, 75%, 50%, 25%, 0.
  const yTicks = [
    config.yMax,
    config.yMax * 0.75,
    config.yMax * 0.5,
    config.yMax * 0.25,
    0,
  ];

  const dValue = config.getValue(desktop);
  const mValue = config.getValue(mobile);

  return (
    <div className="rounded-card border border-beige-line bg-card shadow-card px-3 pb-3 pt-3">
      {/* Header row: title left, icon right. */}
      <div className="flex items-center justify-between gap-2">
        <h3
          className="truncate text-[11px] font-bold uppercase text-ink"
          style={{ letterSpacing: "0.06em" }}
        >
          {config.title}
        </h3>
        <div className="flex-shrink-0 text-ink-soft">{config.icon}</div>
      </div>

      {/* Chart area: y-axis labels on the left, grid + bars on the right. */}
      <div
        className="mt-3 flex"
        style={{ height: CHART_HEIGHT + VALUE_LABEL_GAP }}
      >
        {/* Y-axis tick column. Use space-between to push the first
            tick to the top and the last to the bottom. The value-label
            gap padding above keeps everything aligned with the chart's
            bar drawing area. */}
        <div
          className="flex flex-col items-end pr-1.5 text-[9px] tabular-nums text-ink-soft"
          style={{
            height: CHART_HEIGHT,
            marginTop: VALUE_LABEL_GAP,
            justifyContent: "space-between",
            lineHeight: 1,
          }}
        >
          {yTicks.map((v, i) => (
            <span key={i}>{config.yTickFormat(v)}</span>
          ))}
        </div>

        {/* Right side: grid lines + bars + value labels. */}
        <div
          className="relative flex-1"
          style={{ height: CHART_HEIGHT + VALUE_LABEL_GAP }}
        >
          {/* Horizontal grid lines aligned to y-ticks. Pinned to the
              chart's bar drawing area, not the value-label gap above. */}
          <div
            className="pointer-events-none absolute inset-x-0"
            style={{
              top: VALUE_LABEL_GAP,
              height: CHART_HEIGHT,
            }}
          >
            <div className="flex h-full flex-col justify-between">
              {yTicks.map((_, i) => (
                <div
                  key={i}
                  className="border-t border-dashed border-beige-line/70"
                />
              ))}
            </div>
          </div>

          {/* Bars sit on top of the grid. The value-label gap reserves
              space above the tallest possible bar so labels never
              clip the title above. */}
          <div
            className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-3"
            style={{ height: CHART_HEIGHT + VALUE_LABEL_GAP }}
          >
            <PsiChartBar
              value={dValue}
              yMax={config.yMax}
              chartHeight={CHART_HEIGHT}
              valueLabelGap={VALUE_LABEL_GAP}
              color={config.getColor(dValue)}
              valueLabel={config.formatValueLabel(dValue)}
              device="desktop"
            />
            <PsiChartBar
              value={mValue}
              yMax={config.yMax}
              chartHeight={CHART_HEIGHT}
              valueLabelGap={VALUE_LABEL_GAP}
              color={config.getColor(mValue)}
              valueLabel={config.formatValueLabel(mValue)}
              device="mobile"
            />
          </div>
        </div>
      </div>

      {/* X-axis labels below the bars. */}
      <div className="mt-1.5 flex justify-center gap-3 pl-[24px]">
        <div
          className="text-center text-[9px] font-bold uppercase text-ink-soft"
          style={{ width: 44, letterSpacing: "0.08em" }}
        >
          Desktop
        </div>
        <div
          className="text-center text-[9px] font-bold uppercase text-ink-soft"
          style={{ width: 44, letterSpacing: "0.08em" }}
        >
          Mobile
        </div>
      </div>
    </div>
  );
}

/**
 * One bar inside a PsiBarChartCard. Renders a faint full-height "track"
 * (showing the bar's max possible range) plus the actual filled portion
 * in the score-band colour. Mobile bars use 50% alpha so the Desktop /
 * Mobile pair reads as related. The value label floats above the top
 * of the filled bar so the user gets the exact number without reading
 * the y-axis.
 */
function PsiChartBar({
  value,
  yMax,
  chartHeight,
  valueLabelGap,
  color,
  valueLabel,
  device,
}: {
  value: number | null;
  yMax: number;
  chartHeight: number;
  valueLabelGap: number;
  color: string;
  valueLabel: string;
  device: "desktop" | "mobile";
}) {
  const clamped = Math.max(0, Math.min(yMax, value ?? 0));
  const filledHeight = (clamped / yMax) * chartHeight;
  const barBg = device === "mobile" ? `${color}80` : color;
  return (
    <div
      className="relative flex flex-col items-center"
      style={{ width: 44, height: chartHeight + valueLabelGap }}
    >
      {/* Faint full-height track. Sits at the bottom and extends to the
          chart top (height: chartHeight), inside the value-label gap. */}
      <div
        className="absolute inset-x-0 rounded-t-md"
        style={{
          bottom: 0,
          height: chartHeight,
          background: "rgba(20, 30, 28, 0.05)",
        }}
      />
      {/* Filled bar on top of the track. */}
      <div
        className="absolute inset-x-0 rounded-t-md transition-all"
        style={{
          bottom: 0,
          height: `${filledHeight}px`,
          background: barBg,
          minHeight: value == null ? 0 : "2px",
        }}
      />
      {/* Value label floats just above the top of the filled bar. */}
      {value != null && (
        <div
          className="absolute inset-x-0 text-center text-[11px] font-bold tabular-nums leading-none"
          style={{
            bottom: `${filledHeight + 4}px`,
            color,
          }}
        >
          {valueLabel}
        </div>
      )}
    </div>
  );
}

function ScoreBar({ label, score }: { label: string; score: number | null }) {
  const value = score ?? 0;
  const color = score == null ? "#c4c0b6" : scoreColor(score);
  return (
    <div className="flex items-center gap-3">
      <div className="w-16 text-[11px] font-bold uppercase text-ink-soft" style={{ letterSpacing: "0.1em" }}>
        {label}
      </div>
      <div className="relative h-4 flex-1 overflow-hidden rounded-full bg-beige-line">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: color,
          }}
        />
      </div>
      <div
        className="w-10 text-right text-[14px] font-bold tabular-nums"
        style={{ color }}
      >
        {score == null ? "—" : score}
      </div>
    </div>
  );
}

/** Auto-generated summary bullets used by BOTH the PSI section's UI and
 *  the clipboard-copy format. Extracted so the two stay in sync. */
function computePsiSummaryBullets(
  desktop?: PsiBreakdown,
  mobile?: PsiBreakdown,
): string[] {
  const bullets: string[] = [];

  const catWorst = PSI_CATEGORIES.map((cat) => ({
    cat,
    worst: Math.min(
      catScore(desktop, cat.key) ?? 100,
      catScore(mobile, cat.key) ?? 100,
    ),
  }));
  const weakestCategory = catWorst
    .filter((c) => c.worst < 70)
    .sort((a, b) => a.worst - b.worst)[0];
  if (weakestCategory) {
    bullets.push(
      `${weakestCategory.cat.label} is the weakest category, scoring as low as ${weakestCategory.worst}/100.`,
    );
  }

  for (const cat of PSI_CATEGORIES) {
    const d = catScore(desktop, cat.key);
    const m = catScore(mobile, cat.key);
    if (d != null && m != null && Math.abs(d - m) >= 15) {
      bullets.push(
        `${cat.label} differs by ${Math.abs(d - m)} points between desktop (${d}) and mobile (${m}).`,
      );
    }
    const worst = Math.min(d ?? 100, m ?? 100);
    if (worst === 100) {
      bullets.push(`${cat.label} scores a perfect 100 on both desktop and mobile.`);
    }
  }

  const pick = mobile ?? desktop;
  if (pick?.lcpMs != null && pick.lcpMs > 2500) {
    bullets.push(
      `LCP is ${(pick.lcpMs / 1000).toFixed(2)}s, above Google's 2.5s "good" threshold.`,
    );
  }
  if (pick?.cls != null && pick.cls > 0.1) {
    bullets.push(
      `CLS sits at ${pick.cls.toFixed(2)}, above the 0.1 threshold for visual stability.`,
    );
  }
  if (pick?.tbtMs != null && pick.tbtMs > 200) {
    bullets.push(
      `Total Blocking Time is ${Math.round(pick.tbtMs)}ms, indicating JavaScript is delaying interactivity.`,
    );
  }
  if (pick?.totalByteWeight != null && pick.totalByteWeight > 2 * 1024 * 1024) {
    bullets.push(
      `Page weight is ${(pick.totalByteWeight / 1024 / 1024).toFixed(2)} MB, heavier than the 2MB recommended ceiling.`,
    );
  }

  if (bullets.length === 0) {
    bullets.push(
      "All four Lighthouse categories scored within healthy bands across desktop and mobile.",
    );
  }
  return bullets;
}

function PsiSummary({
  desktop,
  mobile,
}: {
  desktop?: PsiBreakdown;
  mobile?: PsiBreakdown;
}) {
  const bullets = computePsiSummaryBullets(desktop, mobile);

  return (
    <div className="rounded-card border border-beige-line bg-bg/40 px-5 py-4">
      <div
        className="text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        Summary
      </div>
      <ol className="m-0 mt-3 flex flex-col gap-2 list-none p-0">
        {bullets.slice(0, 8).map((b, i) => (
          <li
            key={i}
            className="flex items-center gap-3 text-[13px] font-medium leading-[1.55] text-ink"
          >
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-bold tabular-nums text-white">
              {i + 1}
            </span>
            <span>{b}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- Screenshots ------------------------------------------------- */

/**
 * Above-the-Fold Screenshots.
 *
 * Each card grows to its image's natural aspect ratio. No artificial height
 * crop — Joe specifically wants to see the screenshot at full resolution
 * and have the BOX match the screenshot's shape, not chop the image off.
 * The image is constrained to `max-width: 100%` so the card width controls
 * scale, while `height: auto` keeps the natural aspect.
 */
function ScreenshotsBlock({ data }: { data: AnalyzeResponse }) {
  if (!data.desktopScreenshot && !data.mobileScreenshot) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        PageSpeed Insights didn&apos;t return screenshots for this run.
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-6 md:flex-row md:items-start md:justify-center">
      {data.desktopScreenshot && (
        <ScreenshotCard
          label="DESKTOP"
          src={data.desktopScreenshot}
          mode="desktop"
        />
      )}
      {data.mobileScreenshot && (
        <ScreenshotCard
          label="MOBILE"
          src={data.mobileScreenshot}
          mode="mobile"
        />
      )}
    </div>
  );
}

function ScreenshotCard({
  label,
  src,
  mode,
  lightboxMode = "atf",
}: {
  label: string;
  src: string;
  mode: "desktop" | "mobile";
  /** Which lightbox layout to use when this card is clicked. Defaults to
   *  "atf" (single-viewport image, centered to fit). The Full Page
   *  Screenshot section passes "fullpage" so the overlay scrolls. */
  lightboxMode?: LightboxMode;
}) {
  const open = useLightboxOpen();
  return (
    <div
      className={
        "overflow-hidden rounded-card border border-beige-line bg-card " +
        (mode === "desktop" ? "md:flex-1 md:min-w-0" : "md:w-[320px] md:flex-shrink-0")
      }
    >
      <div
        className="flex items-center justify-between border-b border-beige-line px-4 py-3 text-[11px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.12em" }}
      >
        <span>{label}</span>
      </div>
      {/* Wrapped in a button so the whole image becomes a click target
          for opening the lightbox. The button strips its default chrome
          via p-0/border-0 so visually it still looks like the raw image
          card. cursor:zoom-in signals interactivity. */}
      <button
        type="button"
        onClick={() => open?.({ src, mode: lightboxMode, alt: label })}
        className="block w-full p-0 border-0 bg-transparent text-left"
        style={{ cursor: "zoom-in" }}
        aria-label={`Open ${label.toLowerCase()} screenshot`}
      >
        {/* Image displays at its natural aspect ratio inside the card.
            width:100% scales to card width, height:auto keeps the proportion. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label}
          className="block"
          style={{
            width: "100%",
            height: "auto",
            display: "block",
          }}
        />
      </button>
    </div>
  );
}

/**
 * Bottom-of-report section showing the full scrolled-page captures from
 * Microlink (one for desktop, one for mobile). Reuses ScreenshotCard but
 * passes lightboxMode="fullpage" so clicking opens the scrollable
 * lightbox layout instead of the centered single-viewport one.
 *
 * If only one of the two devices captured successfully we still render
 * the section with just that card.
 */
function FullPageScreenshotsBlock({ data }: { data: AnalyzeResponse }) {
  const hasDesktop = !!data.desktopFullPageScreenshot;
  const hasMobile = !!data.mobileFullPageScreenshot;
  if (!hasDesktop && !hasMobile) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        We couldn&apos;t capture full-page screenshots for this run.
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-6 md:flex-row md:items-start md:justify-center">
      {hasDesktop && (
        <ScreenshotCard
          label="DESKTOP (FULL PAGE)"
          src={data.desktopFullPageScreenshot as string}
          mode="desktop"
          lightboxMode="fullpage"
        />
      )}
      {hasMobile && (
        <ScreenshotCard
          label="MOBILE (FULL PAGE)"
          src={data.mobileFullPageScreenshot as string}
          mode="mobile"
          lightboxMode="fullpage"
        />
      )}
    </div>
  );
}

/**
 * 3-4 sentence narrative for the Overview's Summary panel.
 *
 * Tone shifts with how many dimensions are doing well so the reader gets
 * an honest, balanced read instead of a blanket negative verdict whenever
 * one or two cards are red.
 *
 *   ≥ 4 cards in the green band (≥ 70):  optimistic. Lead with wins, then
 *                                         the one or two areas to lift.
 *   3 weak cards (< 60):                  balanced. "Half of the page is
 *                                         working, half needs attention."
 *   ≥ 4 weak cards (< 60):                urgent. "Most of the page needs
 *                                         improvement, starting with X."
 */
function overallSummary(data: AnalyzeResponse): string {
  const order: CheckKey[] = [
    "speed",
    "aboveTheFold",
    "cro",
    "content",
    "mobile",
    "digestibility",
  ];
  const entries = order.map((k) => ({
    key: k,
    score: data.checks[k].score,
    label: CHECK_META[k].title,
  }));

  // Tier the six dimensions: green (≥70), amber (40–69), red (<40).
  const green = entries.filter((e) => e.score >= 70);
  const weak = entries.filter((e) => e.score < 60);
  const strong = entries.filter((e) => e.score >= 75);

  const list = (arr: { label: string }[]) =>
    arr.length === 0
      ? ""
      : arr.length === 1
      ? arr[0].label
      : arr.length === 2
      ? `${arr[0].label} and ${arr[1].label}`
      : `${arr.slice(0, -1).map((e) => e.label).join(", ")}, and ${arr[arr.length - 1].label}`;

  // ≥ 4 strong → optimistic
  if (green.length >= 4 && weak.length <= 2) {
    const wins = strong.length > 0 ? strong : green;
    const lead = `You're already scoring really well on ${list(wins.slice(0, 3))}.`;
    if (weak.length === 0) {
      return `${lead} Every dimension is holding up. The cards below pick out small tweaks to push everything into best-in-class territory.`;
    }
    if (weak.length === 1) {
      return `${lead} The one area to focus on is ${weak[0].label} (${weak[0].score}/100). The cards below show the specific page-level fix that will move the needle.`;
    }
    return `${lead} Two areas need attention: ${list(weak)}. The cards below show the specific changes to make there.`;
  }

  // ≥ 4 weak → urgent
  if (weak.length >= 4) {
    const lead = `Four or more dimensions are scoring below 60: ${list(weak.slice(0, 4))}.`;
    const positive =
      green.length > 0
        ? ` ${list(green)} ${green.length === 1 ? "is" : "are"} holding up, so the base is salvageable.`
        : "";
    return `${lead}${positive} Treat the cards below as a prioritised punch list — start at the top.`;
  }

  // ~3 weak → balanced "half and half"
  if (weak.length === 3) {
    const positive =
      green.length >= 2
        ? `You're doing well on ${list(green.slice(0, 3))}.`
        : strong.length > 0
        ? `${list(strong)} ${strong.length === 1 ? "is" : "are"} holding up.`
        : "There's a baseline to build from.";
    return `${positive} Three areas need real attention: ${list(weak)}. The cards below show exactly what to change in each.`;
  }

  // Default — 1–2 weak, 2–3 green
  const lead =
    green.length > 0
      ? `You're scoring well on ${list(green.slice(0, 3))}.`
      : "There are no standout strengths on this page yet.";
  if (weak.length === 0) {
    return `${lead} Nothing in the red, the cards below pick out small tweaks to keep momentum.`;
  }
  if (weak.length === 1) {
    return `${lead} The one area to lift is ${weak[0].label} (${weak[0].score}/100). The cards below show the page-specific fix.`;
  }
  return `${lead} The two areas to lift are ${list(weak)}. The cards below break down what to change in each.`;
}

// ---------------------------------------------------------------------------
// Stage Trace inspector (debug)
//
// Renders the per-phase debug trace returned by /api/analyze?debug=1.
// Shows the content produced at each pipeline stage and the items that
// were removed at each stage with reasons, so we can spot weak points
// in the pipeline and tune prompts / filters.
// ---------------------------------------------------------------------------

interface CheckResultLite {
  score: number;
  headline: string;
  notes: string[];
}
interface FilterDropLite {
  text: string;
  reason: string;
}
interface CriticVerdictLite {
  scope?: string;
  kind?: string;
  dim?: string;
  decision: "KEEP" | "REWRITE" | "DROP";
  before: string;
  after?: string;
  reason?: string;
}
interface DimensionTraceLite {
  raw: CheckResultLite;
  filterDrops: FilterDropLite[];
  headlineCleanup: { before: string; after: string; reason: string } | null;
  afterFilter: CheckResultLite;
  criticVerdicts: CriticVerdictLite[];
  afterCritic: CheckResultLite;
  afterSweep: CheckResultLite;
}
interface TakeawayLite {
  text?: string;
  category?: string;
}
interface TakeawaysTraceLite {
  raw: Array<TakeawayLite | string>;
  filterDrops: FilterDropLite[];
  afterFilter: Array<TakeawayLite | string>;
  criticVerdicts: CriticVerdictLite[];
  afterCritic: Array<TakeawayLite | string>;
  afterSweep: Array<TakeawayLite | string>;
}
interface DebugTraceLite {
  vision: Record<string, unknown> | null;
  dimensions: Record<string, DimensionTraceLite>;
  takeaways: TakeawaysTraceLite;
  contradictionSweep: {
    drops: Array<{ origin: string; topic: string; text: string }>;
  };
  timings?: {
    visionPrepassMs: number | null;
    dimsMs: Record<string, number>;
    dimFilterMs: number;
    takeawaysMs: number;
    dimsCriticMs: number;
    takeawaysFilterMs: number;
    takeawaysCriticMs: number;
    contradictionSweepMs: number;
    totalAnalyzeMs: number;
  };
  phase0?: {
    psiDesktopMs: number;
    psiMobileMs: number;
    fetchPageMs: number;
    microDesktopMs: number;
    microMobileMs: number;
    microDesktopFullMs?: number;
    microMobileFullMs?: number;
    phase0WallClockMs: number;
  };
  totalRouteMs?: number;
}

function StageTraceBlock({ trace: traceUnknown }: { trace: unknown }) {
  const trace = traceUnknown as DebugTraceLite;
  return (
    <div className="space-y-6 text-[13px] leading-[1.55] text-ink">
      {(trace.timings || trace.phase0) && (
        <StageGroup title={`Phase timings (total: ${formatMs(trace.totalRouteMs ?? trace.timings?.totalAnalyzeMs)})`}>
          <TimingsTable trace={trace} />
        </StageGroup>
      )}

      <StageGroup title="Phase 2: Vision pre-pass (screenshots → JSON facts)">
        {trace.vision ? (
          <pre className="overflow-x-auto rounded-md border border-beige-line bg-bg p-3 text-[12px] font-mono leading-[1.5] text-ink">
            {JSON.stringify(trace.vision, null, 2)}
          </pre>
        ) : (
          <em className="text-ink-soft">Vision pre-pass returned null (failed or skipped).</em>
        )}
      </StageGroup>

      {(["content", "digestibility", "cro", "aboveTheFold", "mobile"] as const).map((dim) => (
        <DimensionTracePanel key={dim} dim={dim} trace={trace.dimensions[dim]} />
      ))}

      <StageGroup title="Takeaways pipeline (Phase 4 raw → filter → Phase 5 critic → sweep)">
        <Subsection label="Phase 4: Raw takeaways from Claude">
          <TakeawaysList items={trace.takeaways.raw} />
        </Subsection>
        <Subsection label={`Phase 4b filter drops (${trace.takeaways.filterDrops.length})`}>
          <DropsList drops={trace.takeaways.filterDrops} />
        </Subsection>
        <Subsection label="After filter">
          <TakeawaysList items={trace.takeaways.afterFilter} />
        </Subsection>
        <Subsection
          label={`Phase 5 critic verdicts (${trace.takeaways.criticVerdicts.length}, ${countVerdicts(trace.takeaways.criticVerdicts)})`}
        >
          <CriticVerdictsList verdicts={trace.takeaways.criticVerdicts} />
        </Subsection>
        <Subsection label="After critic">
          <TakeawaysList items={trace.takeaways.afterCritic} />
        </Subsection>
        <Subsection label="Final (after contradiction sweep)">
          <TakeawaysList items={trace.takeaways.afterSweep} />
        </Subsection>
      </StageGroup>

      <StageGroup title={`Phase 6: Contradiction sweep drops (${trace.contradictionSweep.drops.length})`}>
        {trace.contradictionSweep.drops.length === 0 ? (
          <em className="text-ink-soft">No drops on this run.</em>
        ) : (
          <ul className="space-y-2">
            {trace.contradictionSweep.drops.map((d, i) => (
              <li key={i} className="rounded-md border border-beige-line bg-bg p-2.5">
                <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
                  {d.origin} · {d.topic}
                </div>
                <div className="mt-1 text-ink">{d.text}</div>
              </li>
            ))}
          </ul>
        )}
      </StageGroup>
    </div>
  );
}

function DimensionTracePanel({
  dim,
  trace,
}: {
  dim: string;
  trace: DimensionTraceLite | undefined;
}) {
  if (!trace) return null;
  return (
    <StageGroup title={`Phase 3-6: ${dim} dimension`}>
      <Subsection label={`Phase 3 raw (score ${trace.raw.score})`}>
        <CheckResultBlock r={trace.raw} />
      </Subsection>
      <Subsection label={`Phase 3b filter drops (${trace.filterDrops.length})`}>
        <DropsList drops={trace.filterDrops} />
      </Subsection>
      {trace.headlineCleanup && (
        <Subsection label="Phase 3b headline cleanup">
          <div className="rounded-md border border-beige-line bg-bg p-2.5">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
              {trace.headlineCleanup.reason}
            </div>
            <div className="mt-1">
              <span className="text-ink-soft">before:</span> {trace.headlineCleanup.before}
            </div>
            <div className="mt-1">
              <span className="text-ink-soft">after:</span>{" "}
              {trace.headlineCleanup.after || <em>(blanked)</em>}
            </div>
          </div>
        </Subsection>
      )}
      <Subsection label="After filter">
        <CheckResultBlock r={trace.afterFilter} />
      </Subsection>
      <Subsection
        label={`Phase 4 critic verdicts (${trace.criticVerdicts.length}, ${countVerdicts(trace.criticVerdicts)})`}
      >
        <CriticVerdictsList verdicts={trace.criticVerdicts} />
      </Subsection>
      <Subsection label="After critic">
        <CheckResultBlock r={trace.afterCritic} />
      </Subsection>
      <Subsection label="Final (after contradiction sweep)">
        <CheckResultBlock r={trace.afterSweep} />
      </Subsection>
    </StageGroup>
  );
}

function StageGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-lg border border-beige-line bg-card p-3">
      <summary className="cursor-pointer text-[14px] font-semibold tracking-tight text-ink">
        {title}
      </summary>
      <div className="mt-3 space-y-4">{children}</div>
    </details>
  );
}

function Subsection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
        {label}
      </div>
      {children}
    </div>
  );
}

function CheckResultBlock({ r }: { r: CheckResultLite }) {
  return (
    <div className="rounded-md border border-beige-line bg-bg p-2.5">
      <div className="mb-1 text-[12px] font-semibold text-ink">
        Headline: {r.headline || <em className="text-ink-soft">(blank)</em>}
      </div>
      {r.notes.length === 0 ? (
        <em className="text-ink-soft">No notes.</em>
      ) : (
        <ul className="ml-4 list-disc space-y-1">
          {r.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DropsList({ drops }: { drops: FilterDropLite[] }) {
  if (drops.length === 0) return <em className="text-ink-soft">No drops.</em>;
  return (
    <ul className="space-y-2">
      {drops.map((d, i) => (
        <li key={i} className="rounded-md border border-beige-line bg-bg p-2.5">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
            {d.reason}
          </div>
          <div className="mt-1 text-ink">{d.text}</div>
        </li>
      ))}
    </ul>
  );
}

function CriticVerdictsList({ verdicts }: { verdicts: CriticVerdictLite[] }) {
  if (verdicts.length === 0)
    return <em className="text-ink-soft">No verdicts.</em>;
  const interesting = verdicts.filter((v) => v.decision !== "KEEP");
  if (interesting.length === 0) {
    return (
      <em className="text-ink-soft">All {verdicts.length} items kept as-is.</em>
    );
  }
  return (
    <ul className="space-y-2">
      {interesting.map((v, i) => (
        <li key={i} className="rounded-md border border-beige-line bg-bg p-2.5">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
            {v.decision} · {v.kind ?? ""} · {v.reason ?? "(no reason)"}
          </div>
          <div className="mt-1">
            <span className="text-ink-soft">before:</span> {v.before}
          </div>
          {v.after && (
            <div className="mt-1">
              <span className="text-ink-soft">after:</span> {v.after}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function TakeawaysList({ items }: { items: Array<TakeawayLite | string> }) {
  if (items.length === 0)
    return <em className="text-ink-soft">No takeaways.</em>;
  return (
    <ul className="ml-4 list-disc space-y-1">
      {items.map((tk, i) => {
        const text = typeof tk === "string" ? tk : tk.text ?? "";
        const cat = typeof tk === "string" ? null : tk.category ?? null;
        return (
          <li key={i}>
            {cat && (
              <span className="mr-1.5 rounded bg-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
                {cat}
              </span>
            )}
            {text}
          </li>
        );
      })}
    </ul>
  );
}

function countVerdicts(verdicts: CriticVerdictLite[]): string {
  const k = verdicts.filter((v) => v.decision === "KEEP").length;
  const r = verdicts.filter((v) => v.decision === "REWRITE").length;
  const d = verdicts.filter((v) => v.decision === "DROP").length;
  return `${k} KEEP · ${r} REWRITE · ${d} DROP`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function TimingsTable({ trace }: { trace: DebugTraceLite }) {
  const t = trace.timings;
  const p0 = trace.phase0;
  const rows: Array<{ label: string; ms: number | null | undefined; note?: string }> = [];
  if (p0) {
    const microNotes = [
      `PSI desktop ${formatMs(p0.psiDesktopMs)}`,
      `PSI mobile ${formatMs(p0.psiMobileMs)}`,
      `HTML fetch ${formatMs(p0.fetchPageMs)}`,
      `Microlink desktop ATF ${formatMs(p0.microDesktopMs)}`,
      `Microlink mobile ATF ${formatMs(p0.microMobileMs)}`,
      p0.microDesktopFullMs != null
        ? `Microlink desktop full ${formatMs(p0.microDesktopFullMs)}`
        : null,
      p0.microMobileFullMs != null
        ? `Microlink mobile full ${formatMs(p0.microMobileFullMs)}`
        : null,
    ].filter(Boolean).join(", ");
    rows.push({
      label: "Phase 0: fetches (wall-clock, parallel)",
      ms: p0.phase0WallClockMs,
      note: microNotes,
    });
  }
  if (t) {
    rows.push({ label: "Phase 2: vision pre-pass", ms: t.visionPrepassMs });
    rows.push({
      label: "Phase 3: 5 dim calls (parallel)",
      ms: Math.max(...Object.values(t.dimsMs || {})),
      note: Object.entries(t.dimsMs || {})
        .map(([k, v]) => `${k} ${formatMs(v)}`)
        .join(", "),
    });
    rows.push({ label: "Phase 3b: dim filters (deterministic)", ms: t.dimFilterMs });
    rows.push({ label: "Phase 4: takeaways call (parallel with dims-critic)", ms: t.takeawaysMs });
    rows.push({ label: "Phase 4: dims-critic call (extended thinking)", ms: t.dimsCriticMs });
    rows.push({ label: "Phase 4b: takeaways filter", ms: t.takeawaysFilterMs });
    rows.push({ label: "Phase 5: takeaways-critic call", ms: t.takeawaysCriticMs });
    rows.push({ label: "Phase 6: contradiction sweep (deterministic)", ms: t.contradictionSweepMs });
    rows.push({ label: "Total inside analyzeWithClaude", ms: t.totalAnalyzeMs });
  }
  if (trace.totalRouteMs != null) {
    rows.push({ label: "TOTAL ROUTE WALL-CLOCK", ms: trace.totalRouteMs });
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-ink-soft">
            <th className="pb-2 pr-4">Phase</th>
            <th className="pb-2 pr-4">Time</th>
            <th className="pb-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isTotal = r.label.toLowerCase().includes("total");
            return (
              <tr
                key={i}
                className={isTotal ? "border-t border-beige-line font-semibold" : "border-t border-beige-line/60"}
              >
                <td className="py-1.5 pr-4 align-top text-ink">{r.label}</td>
                <td className="py-1.5 pr-4 align-top font-mono tabular-nums text-ink">
                  {formatMs(r.ms)}
                </td>
                <td className="py-1.5 align-top text-[11.5px] text-ink-soft">{r.note ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
