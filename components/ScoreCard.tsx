import type { CheckResult } from "@/lib/types";
import { scoreColor } from "@/lib/scoreColor";

interface Props {
  title: string;
  icon: React.ReactNode;
  result: CheckResult;
}

/**
 * Truncate a bullet-point note to a hard word cap. Each Breakdown bullet
 * stays under 40 words so the cards remain skimmable; anything longer
 * gets cut at the boundary with an ellipsis. Programmatic safety net on
 * top of the 40-word instruction in DIMENSION_OUTPUT_RULE.
 */
const MAX_NOTE_WORDS = 40;
function capNote(text: string): string {
  if (!text) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= MAX_NOTE_WORDS) return text;
  return words.slice(0, MAX_NOTE_WORDS).join(" ").replace(/[,;:.]+$/, "") + "…";
}

export default function ScoreCard({ title, icon, result }: Props) {
  const color = scoreColor(result.score);
  return (
    <div className="group relative overflow-hidden rounded-card border border-beige-line bg-card p-6 shadow-card transition hover:-translate-y-0.5 hover:shadow-cardHover">
      <div
        className="absolute inset-x-0 top-0 h-1"
        style={{ background: color }}
      />
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-[10px]"
            style={{ background: `${color}18`, color }}
          >
            {icon}
          </div>
          <h3
            className="text-[13px] font-bold uppercase text-ink"
            style={{ letterSpacing: "0.06em" }}
          >
            {title}
          </h3>
        </div>
        <div
          className="flex items-baseline gap-0.5 font-bold tabular-nums tracking-tight"
          style={{ color }}
        >
          <span className="text-[32px] leading-none">{result.score}</span>
          <span className="text-[11px] text-ink-soft font-semibold">/100</span>
        </div>
      </div>
      <p className="mt-4 text-sm font-medium leading-[1.6] text-ink">
        {result.headline}
      </p>
      {result.notes.length > 0 && (
        <ul className="mt-4 space-y-2 text-[12.5px] font-medium leading-[1.6] text-ink-soft">
          {result.notes.map((n, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-[9px] inline-block h-1 w-1 flex-shrink-0 rounded-full bg-accent-lite" />
              <span>{capNote(n)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
