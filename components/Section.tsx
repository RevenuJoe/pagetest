/**
 * Collapsible section using native <details>. The summary is a clickable
 * header with the section title in small-caps ink-soft + a chevron that
 * rotates when open.
 */

export default function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
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
        <h2
          className="m-0 text-[12px] font-bold uppercase text-ink-soft"
          style={{ letterSpacing: "0.18em" }}
        >
          {title}
        </h2>
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
      </summary>
      <div className="border-t border-beige-line px-7 py-7">{children}</div>
    </details>
  );
}
