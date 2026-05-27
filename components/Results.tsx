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

import type { AnalyzeResponse, CheckKey, CheckResult } from "@/lib/types";
import ScoreRing from "@/components/ScoreRing";
import ScoreCard from "@/components/ScoreCard";
import Section from "@/components/Section";
import { CHECK_META, IconRerun } from "@/components/Icons";
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
  return (
    <div className="space-y-5">
      <Section title="The Overview">
        <OverviewBlock data={data} onRerun={onRerun} rerunning={rerunning} />
      </Section>
      <Section title="Breakdown">
        <BreakdownBlock data={data} />
      </Section>
      <Section title="Key Takeaways">
        <KeyTakeawaysBlock data={data} />
      </Section>
      <Section title="Technical Improvements">
        <TechnicalImprovementsBlock data={data} />
      </Section>
      <Section title="Initial Load Screenshots">
        <ScreenshotsBlock data={data} />
      </Section>
    </div>
  );
}

function OverviewBlock({
  data,
  onRerun,
  rerunning,
}: {
  data: AnalyzeResponse;
  onRerun?: () => void;
  rerunning: boolean;
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
        <div className="flex-1 min-w-0">
          <MetaRow label="Report name" value={displayName(data)} />
          <div className="mt-3">
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
          </div>
          <div className="mt-3">
            <MetaRow
              label="Analysed"
              value={new Date(data.analyzedAt).toLocaleString()}
            />
          </div>
          <p className="mt-4 max-w-[540px] text-sm font-medium leading-[1.65] text-ink">
            {overallSummary(data.overall)}
          </p>
        </div>
        {onRerun && (
          <div className="flex flex-shrink-0 items-center">
            <button
              type="button"
              onClick={onRerun}
              disabled={rerunning}
              className="inline-flex items-center gap-1.5 rounded-full border border-beige-line bg-card px-4 py-2 text-[12px] font-semibold text-ink-soft transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <IconRerun />
              {rerunning ? "Rerunning…" : "Rerun"}
            </button>
          </div>
        )}
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
      <div className="mt-1 text-[16px] font-bold tracking-tight text-ink">
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
      {items.map((it) => {
        const savings = formatSavings(it);
        const tagClass = sourceTagClass(it.source);
        const tagLabel =
          it.source === "both"
            ? "DESKTOP + MOBILE"
            : it.source === "mobile"
            ? "MOBILE"
            : "DESKTOP";
        return (
          <li
            key={it.id}
            className="rounded-card border border-beige-line bg-bg/40 px-4 py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
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
            {it.description && (
              <p className="mt-1.5 text-[13px] font-medium leading-[1.55] text-ink-soft">
                {it.description}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
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

/**
 * Initial Load Screenshots.
 *
 * Both screenshots are rendered at the same fixed height (480px) using
 * `object-fit: contain`. PSI's full-page screenshots are taller than they
 * are wide on mobile, so when constrained to the same height, mobile
 * naturally becomes a narrower column and the image displays at close to
 * its native pixel size (which fixes the blurry upscale issue from
 * stretching it to fill a 50% grid column).
 */
function ScreenshotsBlock({ data }: { data: AnalyzeResponse }) {
  if (!data.desktopScreenshot && !data.mobileScreenshot) {
    return (
      <p className="text-sm font-medium text-ink-soft">
        PageSpeed Insights didn&apos;t return screenshots for this run.
      </p>
    );
  }
  const H = 480;
  return (
    <div className="flex flex-col items-stretch gap-6 md:flex-row md:items-stretch md:justify-center">
      {data.desktopScreenshot && (
        <ScreenshotCard
          label="DESKTOP"
          src={data.desktopScreenshot}
          height={H}
          mode="desktop"
        />
      )}
      {data.mobileScreenshot && (
        <ScreenshotCard
          label="MOBILE"
          src={data.mobileScreenshot}
          height={H}
          mode="mobile"
        />
      )}
    </div>
  );
}

function ScreenshotCard({
  label,
  src,
  height,
  mode,
}: {
  label: string;
  src: string;
  height: number;
  mode: "desktop" | "mobile";
}) {
  return (
    <div
      className={
        "overflow-hidden rounded-card border border-beige-line bg-card " +
        (mode === "desktop" ? "md:flex-1 md:min-w-0" : "md:flex-shrink-0")
      }
    >
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
      <div className="flex items-start justify-center bg-bg/30" style={{ height }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label}
          className="block"
          style={{ height: "100%", width: "auto", objectFit: "contain" }}
        />
      </div>
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
