/**
 * Collapsible section using native <details>. The summary is a clickable
 * header with the section title in small-caps ink-soft + a chevron that
 * rotates when open.
 */

export default function Section({
  title,
  icon,
  defaultOpen = true,
  headerAction,
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
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-[24px] border border-beige-line bg-card shadow-card overflow-hidden"
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between px-7 py-5"
        style={{ outline: "none" }}
      >
        <div className="flex items-center gap-3 text-ink-soft">
          {icon}
          <h2
            className="m-0 text-[12px] font-bold uppercase"
            style={{ letterSpacing: "0.18em" }}
          >
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {headerAction}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 text-ink-soft transition-transform group-open:rotate-180"
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
