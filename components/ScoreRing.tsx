/**
 * Circular score gauge styled to the Revenu brand: the arc colour resolves
 * from scoreColor (teal at the top end, warm amber/coral at the bottom),
 * the number is heavy Montserrat with a tight letter-spacing, and the
 * label sits in small caps below it.
 */

import { scoreColor } from "@/lib/scoreColor";

interface Props {
  score: number;
  size?: number;
  label?: string;
}

export default function ScoreRing({ score, size = 140, label }: Props) {
  const stroke = size * 0.09;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, Math.max(0, score)) / 100);
  const color = scoreColor(score);

  return (
    <div
      className="relative inline-flex flex-col items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="rgba(28, 31, 29, 0.08)"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1s ease-out" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-bold tabular-nums leading-none tracking-tight"
          style={{ fontSize: size * 0.34, color }}
        >
          {score}
        </span>
        {label && (
          <span
            className="mt-1.5 text-[10px] font-bold uppercase text-ink-soft"
            style={{ letterSpacing: "0.18em" }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}
