/**
 * The six-section report view. Shared between / (after a fresh run) and
 * /reports (when opening a saved report).
 *
 *   1. Overview                     — overall ring + Report name/URL/Analysed + mini scores
 *   2. Key Takeaways                — numbered list from Claude
 *   3. Analysis                     — six ScoreCards (one per dimension)
 *   4. Above-the-Fold Screenshots   — desktop + mobile at matched height
 *   5. PageSpeed Insights           — Desktop vs Mobile comparison + per-strategy chips
 *   6. Technical Improvements       — Lighthouse opportunities + diagnostics
 */

"use client";

import { cloneElement, isValidElement, useEffect, useRef, useState } from "react";
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
} from "@/components/Icons";
import { scoreColor } from "@/lib/scoreColor";
import { displayName } from "@/lib/nameUtil";

export default function Results({
  data,
  onRerun,
  rerunning = false,
}: {
  data: AnalyzeResponse;
  onRerun?: () => void;
  rerunning?: boolean;
}) {
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
          title="Key Takeaways"
          icon={<IconBulb />}
          defaultOpen={false}
          headerAction={
            <CopyButton getText={() => formatTakeawaysForClipboard(data)} />
          }
        >
          <KeyTakeawaysBlock data={data} />
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
    {
      key: "screenshots",
      node: (
        <Section title="Above-the-Fold Screenshots" icon={<IconEye />} defaultOpen={false}>
          <ScreenshotsBlock data={data} />
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
  ];

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

  const formatStrategy = (label: string, b: PsiBreakdown): string => {
    // Lighthouse category scores (also rendered in the comparison chart).
    const cats = PSI_CATEGORIES.map((cat) => {
      const s = catScore(b, cat.key);
      return `- ${cat.label}: ${s == null ? "—" : `${s}/100`}`;
    }).join("\n");
    // Detail metrics rendered inside the strategy card. Mirror the
    // STRATEGY_METRICS array so the clipboard stays in sync with the UI.
    const metrics = STRATEGY_METRICS.map(
      (m) => `- ${m.label}: ${m.getValue(b)}`,
    ).join("\n");
    return `${label}:\n${cats}\n${metrics}`;
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
  const items = (data.keyTakeaways ?? []).slice(0, 5);
  if (items.length === 0) return "";
  const header =
    `Key Takeaways — ${displayName(data)}\n` +
    `${data.url}\n` +
    `${new Date(data.analyzedAt).toLocaleString()}\n` +
    `\n`;
  const body = items
    .map((it, i) => {
      const text = typeof it === "string" ? it : it.text;
      const tag = typeof it === "string" ? "" : `${CHECK_META[it.category].title}: `;
      return `${i + 1}. ${tag}${text}`;
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
          <div className="w-[200px] flex-shrink-0">
            <div className="overflow-hidden rounded-card border border-beige-line bg-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.desktopScreenshot}
                alt="Desktop above-the-fold preview"
                className="block w-full h-auto"
              />
            </div>
          </div>
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
  const items = (data.keyTakeaways ?? []).slice(0, 5);
  if (items.length === 0) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        No takeaways were returned for this run.
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
        const tag = category ? CHECK_META[category].title : null;
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
      {/* Single comparison chart row — five columns side by side:
          Performance / Accessibility / Best Practices / SEO / Speed Index.
          Each column has two vertical bars (Desktop / Mobile). */}
      <PsiCategoryComparison desktop={desktop} mobile={mobile} />

      {/* Per-strategy breakdown: 6 chips per device — Performance,
          Accessibility, Best Practices, SEO, Speed Index, Page Weight. */}
      <div className="grid gap-5 md:grid-cols-2">
        {desktop && <PsiStrategyCard label="Desktop" device="desktop" data={desktop} />}
        {mobile && <PsiStrategyCard label="Mobile" device="mobile" data={mobile} />}
      </div>

      {/* Bullet summary — what stood out across categories. */}
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

function PsiCategoryComparison({
  desktop,
  mobile,
}: {
  desktop?: PsiBreakdown;
  mobile?: PsiBreakdown;
}) {
  // Five columns side-by-side, each with TWO vertical bars (Desktop /
  // Mobile) so divergence reads at a glance. The first four are normal
  // 0-100 scores; the fifth (Speed Index) shows seconds with the same
  // bar UI, mapped to a 0-100 height so it sits visually alongside the
  // others.
  const BAR_HEIGHT = 140; // px — the chart's max bar height
  return (
    <div className="rounded-card border border-beige-line bg-bg/40 px-5 py-4">
      <div
        className="text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        Desktop vs. Mobile
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {PSI_CATEGORIES.map((cat) => {
          const d = catScore(desktop, cat.key);
          const m = catScore(mobile, cat.key);
          return (
            <div
              key={cat.key}
              className="flex flex-col items-center rounded-card border border-beige-line bg-card shadow-card px-3 pb-3 pt-3"
            >
              <div
                className="text-center text-[11px] font-bold uppercase text-ink"
                style={{ letterSpacing: "0.06em" }}
              >
                {cat.label}
              </div>
              <div
                className="mt-3 flex w-full items-end justify-center gap-3"
                style={{ height: BAR_HEIGHT + 24 /* room for value labels */ }}
              >
                <VerticalBar label="Desktop" score={d} maxHeight={BAR_HEIGHT} device="desktop" />
                <VerticalBar label="Mobile" score={m} maxHeight={BAR_HEIGHT} device="mobile" />
              </div>
            </div>
          );
        })}

        {/* Speed Index column — sits on the same row as the four
            categories. Bar height comes from a 0-100 score derived from
            seconds (Lighthouse's bands), but the value above the bar is
            the actual seconds reading so the user sees what matters. */}
        <div className="flex flex-col items-center rounded-card border border-beige-line bg-card shadow-card px-3 pb-3 pt-3">
          <div
            className="text-center text-[11px] font-bold uppercase text-ink"
            style={{ letterSpacing: "0.06em" }}
          >
            Speed Index
          </div>
          <div
            className="mt-3 flex w-full items-end justify-center gap-3"
            style={{ height: BAR_HEIGHT + 24 }}
          >
            <SpeedIndexVerticalBar
              label="Desktop"
              ms={desktop?.speedIndexMs ?? null}
              maxHeight={BAR_HEIGHT}
              device="desktop"
            />
            <SpeedIndexVerticalBar
              label="Mobile"
              ms={mobile?.speedIndexMs ?? null}
              maxHeight={BAR_HEIGHT}
              device="mobile"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Vertical bar for Speed Index. UNLIKE the score bars (where taller =
 * better), this one's height tracks seconds directly: longer page-load
 * time = taller bar = worse. A fast page produces a short, green bar.
 *
 * Colour still follows Lighthouse's official bands so green/orange/red
 * signals good/bad regardless of bar height:
 *   ≤ 3.4s  → green
 *   ≤ 5.8s  → orange
 *   > 5.8s  → red
 *
 * Y-axis tops out at SPEED_INDEX_MAX_SECS (10s) — values beyond that
 * clamp to a full-height red bar.
 */
const SPEED_INDEX_MAX_SECS = 10;

function speedIndexBandColor(secs: number): string {
  if (secs <= 3.4) return scoreColor(95); // green
  if (secs <= 5.8) return scoreColor(60); // orange
  return scoreColor(30); // red
}

function SpeedIndexVerticalBar({
  label,
  ms,
  maxHeight,
  device,
}: {
  label: string;
  ms: number | null;
  maxHeight: number;
  device: "desktop" | "mobile";
}) {
  const seconds = ms == null ? null : ms / 1000;
  const color = seconds == null ? "#c4c0b6" : speedIndexBandColor(seconds);
  // Bar height is proportional to seconds: shorter page-load → shorter
  // bar. Clamp at 10s so an unusually slow run doesn't overflow the
  // chart's drawing area.
  const clamped = Math.min(seconds ?? 0, SPEED_INDEX_MAX_SECS);
  const h = (clamped / SPEED_INDEX_MAX_SECS) * maxHeight;
  // Differentiate Desktop vs Mobile by saturation: Desktop renders at
  // full colour, Mobile uses a softer / lighter version of the same
  // colour so the two bars read as a paired set (like the lighter
  // accent backgrounds used behind the category icons).
  const barBackground = device === "mobile" ? `${color}80` : color;
  return (
    <div className="flex w-full max-w-[44px] flex-col items-center justify-end">
      <div className="text-[13px] font-bold tabular-nums leading-none" style={{ color }}>
        {seconds == null ? "—" : `${seconds.toFixed(2)}s`}
      </div>
      <div
        className="mt-1.5 w-full rounded-t-md transition-all"
        style={{
          height: `${h}px`,
          background: barBackground,
          minHeight: "2px",
        }}
      />
      <div
        className="mt-1.5 text-[9px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.08em" }}
      >
        {label}
      </div>
    </div>
  );
}

/** One vertical bar inside the category-comparison chart. */
function VerticalBar({
  label,
  score,
  maxHeight,
  device,
}: {
  label: string;
  score: number | null;
  maxHeight: number;
  device: "desktop" | "mobile";
}) {
  const value = score ?? 0;
  const color = score == null ? "#c4c0b6" : scoreColor(score);
  const h = Math.max(2, Math.min(100, value)) * (maxHeight / 100);
  // Differentiate Desktop vs Mobile by saturation: Desktop renders at
  // full colour, Mobile uses a softer / lighter version of the same
  // colour (50% alpha) so the two bars read as a paired set with the
  // same lighter-accent feel as the icon backgrounds.
  const barBackground = device === "mobile" ? `${color}80` : color;
  return (
    <div className="flex w-full max-w-[44px] flex-col items-center justify-end">
      <div
        className="text-[13px] font-bold tabular-nums leading-none"
        style={{ color }}
      >
        {score == null ? "—" : score}
      </div>
      <div
        className="mt-1.5 w-full rounded-t-md transition-all"
        style={{
          height: `${h}px`,
          background: barBackground,
          minHeight: "2px",
        }}
      />
      <div
        className="mt-1.5 text-[9px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.08em" }}
      >
        {label}
      </div>
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

/**
 * Detail metrics rendered inside each Desktop / Mobile strategy card.
 * The four Lighthouse category scores (Performance / Accessibility /
 * Best Practices / SEO) already live in the comparison chart above, so
 * the strategy cards now surface the timing-and-weight metrics that
 * actually drive page experience: Core Web Vitals (LCP, CLS), the
 * supporting Lighthouse perf signals (Speed Index, FCP, TBT), and
 * total page weight. Thresholds follow Lighthouse's published bands.
 */
interface StrategyMetric {
  label: string;
  icon: React.ReactNode;
  getValue: (b: PsiBreakdown) => string;
  isGood: (b: PsiBreakdown) => boolean;
  isWarn: (b: PsiBreakdown) => boolean;
}

const STRATEGY_METRICS: StrategyMetric[] = [
  {
    // Speed Index: how quickly visible content paints during page load.
    // Good ≤ 3.4s, poor > 5.8s (Lighthouse).
    label: "Speed Index",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l3 2" />
        <path d="M9 2h6" />
      </svg>
    ),
    getValue: (b) => fmtTime(b.speedIndexMs),
    isGood: (b) => b.speedIndexMs != null && b.speedIndexMs <= 3400,
    isWarn: (b) => b.speedIndexMs != null && b.speedIndexMs > 5800,
  },
  {
    // Largest Contentful Paint: when the biggest visible element loads.
    // Good ≤ 2.5s, poor > 4s (Core Web Vital).
    label: "Largest Contentful Paint",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="11" r="1.5" />
        <path d="M3 17l5-5 4 4 3-3 6 6" />
      </svg>
    ),
    getValue: (b) => fmtTime(b.lcpMs),
    isGood: (b) => b.lcpMs != null && b.lcpMs <= 2500,
    isWarn: (b) => b.lcpMs != null && b.lcpMs > 4000,
  },
  {
    // First Contentful Paint: when the FIRST piece of content appears.
    // Good ≤ 1.8s, poor > 3s (Lighthouse).
    label: "First Contentful Paint",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
      </svg>
    ),
    getValue: (b) => fmtTime(b.fcpMs),
    isGood: (b) => b.fcpMs != null && b.fcpMs <= 1800,
    isWarn: (b) => b.fcpMs != null && b.fcpMs > 3000,
  },
  {
    // Cumulative Layout Shift: visual stability score (unitless).
    // Good ≤ 0.1, poor > 0.25 (Core Web Vital).
    label: "Cumulative Layout Shift",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="3" y="3" width="10" height="10" rx="1" />
        <rect x="11" y="11" width="10" height="10" rx="1" />
      </svg>
    ),
    getValue: (b) => (b.cls == null ? "—" : b.cls.toFixed(2)),
    isGood: (b) => b.cls != null && b.cls <= 0.1,
    isWarn: (b) => b.cls != null && b.cls > 0.25,
  },
  {
    // Total Blocking Time: how long JS blocks the main thread (lab
    // proxy for INP). Good ≤ 200ms, poor > 600ms (Lighthouse).
    label: "Total Blocking Time",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
    ),
    getValue: (b) => fmtTime(b.tbtMs),
    isGood: (b) => b.tbtMs != null && b.tbtMs <= 200,
    isWarn: (b) => b.tbtMs != null && b.tbtMs > 600,
  },
  {
    // Page Weight: total bytes transferred. Thresholds are pragmatic
    // landing-page targets, not a Lighthouse band. Good ≤ 1.5MB,
    // poor > 3MB.
    label: "Page Weight",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <path d="M6 2h12l2 4-8 16L4 6z" />
        <path d="M9 6l3 4 3-4" />
      </svg>
    ),
    getValue: (b) => fmtBytes(b.totalByteWeight),
    isGood: (b) => b.totalByteWeight != null && b.totalByteWeight <= 1.5 * 1024 * 1024,
    isWarn: (b) => b.totalByteWeight != null && b.totalByteWeight > 3 * 1024 * 1024,
  },
];

function PsiStrategyCard({
  label,
  data,
  device,
}: {
  label: string;
  data: PsiBreakdown;
  device: "desktop" | "mobile";
}) {
  // Six chips per strategy: Speed Index, LCP, FCP, CLS, TBT, Page
  // Weight. The four Lighthouse category scores (Performance /
  // Accessibility / Best Practices / SEO) are already shown in the
  // comparison chart above — these cards surface the supporting
  // timing-and-weight metrics so the user gets a complete picture of
  // page experience.
  //
  // Visual pattern mirrors the Overview section: the outer card sits
  // on the lighter (white) background, and the inner stat chips use
  // the same translucent-beige bg as the Overview's per-dimension chips.
  return (
    <div className="rounded-card border border-beige-line bg-card shadow-card px-5 py-4">
      <div
        className="flex items-center gap-2 text-[12px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.18em" }}
      >
        <DeviceIcon device={device} />
        {label}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STRATEGY_METRICS.map((m) => (
          <PsiValueChip
            key={m.label}
            label={m.label}
            value={m.getValue(data)}
            icon={m.icon}
            good={m.isGood(data)}
            warn={m.isWarn(data)}
          />
        ))}
      </div>
    </div>
  );
}

function DeviceIcon({ device }: { device: "desktop" | "mobile" }) {
  if (device === "desktop") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  );
}

/**
 * A Speed Index / Page Weight chip in the same visual style as the
 * Lighthouse category chips, but showing a value (e.g. "2.4 s", "1.8 MB")
 * tinted green when in Google's "good" band and red when "poor".
 */
function PsiValueChip({
  label,
  value,
  icon,
  good,
  warn,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  good?: boolean;
  warn?: boolean;
}) {
  const color = warn ? "#C44536" : good ? "#2F7D6F" : "#76A09C";
  return (
    <div className="flex flex-col items-center gap-1 rounded-card border border-beige-line bg-bg/40 px-3 py-3">
      <div
        className="flex h-7 w-7 items-center justify-center rounded-lg"
        style={{ background: `${color}1a`, color }}
      >
        {icon}
      </div>
      <div
        className="text-[16px] font-bold tabular-nums leading-none tracking-tight"
        style={{ color }}
      >
        {value}
      </div>
      <div
        className="text-center text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.08em" }}
      >
        {label}
      </div>
    </div>
  );
}

function MetricChip({
  label,
  value,
  good,
  warn,
}: {
  label: string;
  value: string;
  good?: boolean;
  warn?: boolean;
}) {
  // Subtle accent on Core Web Vitals — green tint when within Google's
  // "good" threshold, red tint when in the "poor" band.
  const color = warn ? "#C44536" : good ? "#2F7D6F" : undefined;
  return (
    <div className="flex flex-col gap-1 rounded-card border border-beige-line bg-card px-3 py-2.5">
      <div
        className="text-[15px] font-bold tabular-nums leading-none tracking-tight"
        style={{ color: color ?? "#1c1f1d" }}
      >
        {value}
      </div>
      <div
        className="text-[9px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.1em" }}
      >
        {label}
      </div>
    </div>
  );
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function fmtBytes(b: number | null): string {
  if (b == null) return "—";
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
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
      <ul className="m-0 mt-3 flex flex-col gap-2 list-none p-0">
        {bullets.slice(0, 8).map((b, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-[13px] font-medium leading-[1.55] text-ink"
          >
            <span className="mt-[8px] inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
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
}: {
  label: string;
  src: string;
  mode: "desktop" | "mobile";
}) {
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
      {/* Image displays at its natural aspect ratio inside the card.
          width:100% scales to card width, height:auto keeps the proportion.
          No cropping — the card grows to match the screenshot. */}
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
