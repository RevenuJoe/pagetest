/**
 * The four-section report view. Shared between / (after a fresh run) and
 * /reports (when opening a saved report).
 *
 *   1. The Overview      — overall ring + Report name/URL/Analysed + mini scores
 *   2. Breakdown          — six ScoreCards
 *   3. Key Takeaways      — numbered list from Claude
 *   4. Initial Load Screenshots — desktop + mobile at matched height
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
        <Section title={displayName(data)} defaultOpen>
          <OverviewBlock data={data} onRerun={onRerun} rerunning={rerunning ?? false} />
        </Section>
      ),
    },
    {
      key: "breakdown",
      node: (
        <Section title="Breakdown" defaultOpen={false}>
          <BreakdownBlock data={data} />
        </Section>
      ),
    },
    {
      key: "takeaways",
      node: (
        <Section
          title="Key Takeaways"
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
      key: "tech",
      node: (
        <Section
          title="Technical Improvements"
          defaultOpen={false}
          headerAction={
            <CopyButton getText={() => formatTechImprovementsForClipboard(data)} />
          }
        >
          <TechnicalImprovementsBlock data={data} />
        </Section>
      ),
    },
    {
      key: "psi",
      node: (
        <Section title="PageSpeed Insights" defaultOpen={false}>
          <PageSpeedInsightsBlock data={data} />
        </Section>
      ),
    },
    {
      key: "screenshots",
      node: (
        <Section title="Initial Load Screenshots" defaultOpen={false}>
          <ScreenshotsBlock data={data} />
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
      if (i >= sections.length) {
        // All in. Wait a beat, then glide back up to the Overview.
        timers.push(
          setTimeout(() => {
            if (cancelled) return;
            refs.current[0]?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          }, 700),
        );
        return;
      }
      setRevealedIndex(i);
      // Don't auto-scroll on the first section — its container already
      // positioned us at the top of the report.
      if (i > 0) {
        refs.current[i]?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
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
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  return (
    <div>
      {/* Three-column layout: ring on the left, meta in the middle, summary
          on the right. The Rerun button has been removed from this view to
          match Joe's reference. */}
      <div className="flex flex-col items-center gap-8 md:grid md:grid-cols-[auto_1fr_1fr] md:items-start md:gap-12">
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
      {/* Lighthouse category scores — Performance / Accessibility / Best
          Practices / SEO. Bar chart compares desktop vs mobile. */}
      <PsiCategoryComparison desktop={desktop} mobile={mobile} />

      {/* Per-strategy breakdown: category-score chips + Core Web Vitals
          row. Stacks vertically on narrow screens. */}
      <div className="grid gap-5 md:grid-cols-2">
        {desktop && <PsiStrategyCard label="Desktop" data={desktop} />}
        {mobile && <PsiStrategyCard label="Mobile" data={mobile} />}
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
  return (
    <div className="rounded-card border border-beige-line bg-bg/40 px-5 py-4">
      <div
        className="text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        Lighthouse Categories — Desktop vs Mobile
      </div>
      <ul className="mt-4 m-0 flex flex-col gap-3 list-none p-0">
        {PSI_CATEGORIES.map((cat) => {
          const d = catScore(desktop, cat.key);
          const m = catScore(mobile, cat.key);
          return (
            <li key={cat.key} className="flex items-center gap-4">
              <div className="w-[110px] flex-shrink-0 text-[12px] font-semibold text-ink">
                {cat.label}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <ScoreBar label="Desktop" score={d} />
                <ScoreBar label="Mobile" score={m} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScoreBar({ label, score }: { label: string; score: number | null }) {
  const value = score ?? 0;
  const color = score == null ? "#c4c0b6" : scoreColor(score);
  return (
    <div className="flex items-center gap-3">
      <div className="w-14 text-[10px] font-bold uppercase text-ink-soft" style={{ letterSpacing: "0.1em" }}>
        {label}
      </div>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-beige-line">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: color,
          }}
        />
      </div>
      <div
        className="w-10 text-right text-[13px] font-bold tabular-nums"
        style={{ color }}
      >
        {score == null ? "—" : score}
      </div>
    </div>
  );
}

function PsiStrategyCard({
  label,
  data,
}: {
  label: string;
  data: PsiBreakdown;
}) {
  return (
    <div className="rounded-card border border-beige-line bg-bg/40 px-5 py-4">
      <div
        className="text-[11px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.18em" }}
      >
        {label}
      </div>

      {/* Four category-score chips — re-uses the same icon-box style as
          the Overview mini-grid. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PSI_CATEGORIES.map((cat) => (
          <PsiCategoryChip
            key={cat.key}
            label={cat.label}
            score={catScore(data, cat.key)}
            icon={CATEGORY_ICONS[cat.key]}
          />
        ))}
      </div>

      {/* Core Web Vitals + extra timing metrics. */}
      <div
        className="mt-5 text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        Core Web Vitals
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <MetricChip
          label="LCP"
          value={fmtTime(data.lcpMs)}
          good={data.lcpMs != null && data.lcpMs <= 2500}
          warn={data.lcpMs != null && data.lcpMs > 4000}
        />
        <MetricChip
          label="CLS"
          value={data.cls != null ? data.cls.toFixed(2) : "—"}
          good={data.cls != null && data.cls <= 0.1}
          warn={data.cls != null && data.cls > 0.25}
        />
        <MetricChip
          label="TBT"
          value={fmtTime(data.tbtMs)}
          good={data.tbtMs != null && data.tbtMs <= 200}
          warn={data.tbtMs != null && data.tbtMs > 600}
        />
      </div>

      <div
        className="mt-4 text-[10px] font-bold uppercase text-ink-soft"
        style={{ letterSpacing: "0.16em" }}
      >
        Other metrics
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <MetricChip label="FCP" value={fmtTime(data.fcpMs)} />
        <MetricChip label="Speed Index" value={fmtTime(data.speedIndexMs)} />
        <MetricChip label="TTI" value={fmtTime(data.ttiMs)} />
        <MetricChip
          label="Server"
          value={fmtTime(data.serverResponseMs)}
        />
        <MetricChip label="Page weight" value={fmtBytes(data.totalByteWeight)} />
        <MetricChip
          label="DOM size"
          value={data.domSize != null ? data.domSize.toString() : "—"}
        />
      </div>
    </div>
  );
}

const CATEGORY_ICONS: Record<CategoryRow["key"], React.ReactNode> = {
  performance: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  ),
  accessibility: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <circle cx="12" cy="4" r="2" />
      <path d="M19 13a7 7 0 1 1-14 0" />
      <path d="M12 6v6l4 8" />
      <path d="M12 12l-4 8" />
    </svg>
  ),
  bestPractices: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <path d="M12 2L4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  seo: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-5-5" />
    </svg>
  ),
};

function PsiCategoryChip({
  label,
  score,
  icon,
}: {
  label: string;
  score: number | null;
  icon: React.ReactNode;
}) {
  const value = score ?? 0;
  const color = score == null ? "#c4c0b6" : scoreColor(score);
  return (
    <div className="flex flex-col items-center gap-1 rounded-card border border-beige-line bg-card px-3 py-3">
      <div
        className="flex h-7 w-7 items-center justify-center rounded-lg"
        style={{ background: `${color}1a`, color }}
      >
        {icon}
      </div>
      <div
        className="text-[22px] font-bold tabular-nums leading-none tracking-tight"
        style={{ color }}
      >
        {score == null ? "—" : value}
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

function PsiSummary({
  desktop,
  mobile,
}: {
  desktop?: PsiBreakdown;
  mobile?: PsiBreakdown;
}) {
  const bullets: string[] = [];

  // Category-level call-outs.
  for (const cat of PSI_CATEGORIES) {
    const d = catScore(desktop, cat.key);
    const m = catScore(mobile, cat.key);
    if (d != null && m != null) {
      const diff = d - m;
      if (Math.abs(diff) >= 15) {
        bullets.push(
          `${cat.label} differs by ${Math.abs(diff)} points between desktop (${d}) and mobile (${m}).`,
        );
      }
    }
    const worst = Math.min(d ?? 100, m ?? 100);
    if (worst < 70) {
      bullets.push(
        `${cat.label} is the weakest category, scoring as low as ${worst}/100.`,
      );
    } else if (worst === 100) {
      bullets.push(`${cat.label} scores a perfect 100 on both desktop and mobile.`);
    }
  }

  // Core Web Vital flags from whichever strategy we have.
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
 * Initial Load Screenshots.
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
 * 3-4 sentence narrative for the Overview's Summary panel. Composed from
 * the overall score plus the strongest and weakest dimensions so each
 * report reads specific to the page being analysed.
 */
function overallSummary(data: AnalyzeResponse): string {
  const score = data.overall;
  const order: CheckKey[] = [
    "speed",
    "content",
    "digestibility",
    "cro",
    "aboveTheFold",
    "mobile",
  ];
  const entries = order.map((k) => ({
    key: k,
    score: data.checks[k].score,
    label: CHECK_META[k].title,
  }));
  const sortedHigh = [...entries].sort((a, b) => b.score - a.score);
  const sortedLow = [...entries].sort((a, b) => a.score - b.score);
  const top = sortedHigh[0];
  const bottom = sortedLow[0];

  const opener =
    score >= 90
      ? "This page is firing on every dimension we test."
      : score >= 75
      ? "Strong overall, with a handful of targeted opportunities to push it into best-in-class territory."
      : score >= 60
      ? "Solid baseline, but real conversion is being left on the table."
      : score >= 40
      ? "Meaningful weaknesses are showing up across multiple dimensions."
      : "This page has significant problems holding back performance and conversions.";

  const strength =
    top.score >= 80
      ? `${top.label} leads the pack at ${top.score}/100 and is genuinely working for you.`
      : `${top.label} is the strongest area at ${top.score}/100, though it still has room to grow.`;

  const weakness =
    bottom.score < 60
      ? `The lowest score is ${bottom.label} at ${bottom.score}/100 — that's where the biggest lift will come from.`
      : `The lowest score is ${bottom.label} at ${bottom.score}/100, which makes it the easiest win to chase.`;

  const action =
    "The cards below break down each dimension with specific, page-level recommendations.";

  return `${opener} ${strength} ${weakness} ${action}`;
}
