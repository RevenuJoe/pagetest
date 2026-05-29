/**
 * Collapsible section using native <details>. The summary is a clickable
 * header with the section title in small-caps ink-soft + a chevron that
 * rotates when open.
 *
 * Initial open state comes from the `defaultOpen` prop. We use React
 * state plus an `onToggle` handler so the user can freely open/close
 * the section after mount — and crucially so the *initial* open value
 * is locked in even when the parent re-renders during the staggered
 * reveal cascade in Results.tsx. If `defaultOpen` is true, the section
 * is open from the first paint.
 */

"use client";

import { useState } from "react";

export default function Section({
  title,
  icon,
  defaultOpen = true,
  headerAction,
  compact = false,
  children,
}: {
  title: string;
  /** Optional small icon rendered on the LEFT of the title. Picks up the
   *  same ink-soft tint as the title text via currentColor. */
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  /** Optional element rendered to the LEFT of the chevron. Use for icons
   *  that should NOT toggle the section (e.g. a copy-to-clipboard button).
   *  The button itself must stopPropagation + preventDefault on its click
   *  handler — clicking anywhere in a native <summary> toggles the
   *  <details> by default. */
  headerAction?: React.ReactNode;
  /** Mobile-only spacing reduction. The saved-report row uses this so the
   *  three header-action icons (Open, Rerun, Trash) sit closer to the
   *  right edge and the title can use more of the available width. */
  compact?: boolean;
  children: React.ReactNode;
}) {
  // Internal open state. Seeded once from `defaultOpen` so the parent
  // can't force the section back open or closed on every re-render.
  // The native <details> element's onToggle event keeps this in sync
  // with the user's clicks.
  const [open, setOpen] = useState(defaultOpen);

  // Saved-report rows ("compact") shrink the summary padding on mobile:
  // left + right go from px-7 (28px) to px-3.5 (14px), top + bottom from
  // py-5 (20px) to py-3 (12px). Desktop keeps the original spacing.
  const summaryPadding = compact
    ? "px-3.5 py-3 sm:px-7 sm:py-5"
    : "px-7 py-5";
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-[24px] border border-beige-line bg-card shadow-card overflow-hidden"
    >
      <summary
        className={`flex cursor-pointer list-none items-center justify-between ${summaryPadding}`}
        style={{ outline: "none" }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* Soft-green accent chip around the section icon. Matches the
              icon-chip styling on the home page's three hero pills and
              the scrolling feature cards (Digestibility, CRO, etc.). */}
          {icon && (
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-accent-soft text-accent-dark">
              {icon}
            </span>
          )}
          {/* Title truncates on overflow so long page titles don't wrap
              to multiple lines and squeeze the header actions off-screen
              on mobile. */}
          <h2
            className="m-0 min-w-0 truncate text-[12px] font-bold uppercase text-ink-soft"
            style={{ letterSpacing: "0.18em" }}
          >
            {title}
          </h2>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {headerAction}
          {/* Chevron — hidden on mobile to save horizontal space. Clicking
              anywhere on the summary still toggles the <details> because
              <summary> handles that natively. Desktop keeps the visual
              affordance. */}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="hidden h-4 w-4 text-ink-soft transition-transform group-open:rotate-180 sm:block"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </summary>
      <div className="border-t border-beige-line px-7 py-7">{children}</div>
    </details>
  );
}
