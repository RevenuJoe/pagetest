"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { IconReport } from "@/components/Icons";
import { useSavedReports } from "@/lib/storeHooks";

export default function Header({ active = false }: { active?: boolean }) {
  const saved = useSavedReports();
  const count = saved.length;
  const router = useRouter();
  const pathname = usePathname();
  return (
    <header className="px-6 py-5 sm:px-14">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-6">
        <Link
          href="/"
          // Logo click takes you home. Two behaviours:
          //
          //   - Already on "/"  : the home page may be showing a freshly
          //     generated report (the form is filled, results rendered
          //     below). A soft router.push("/") is a no-op since we're
          //     already at /, so the report stays put. Force a full
          //     reload via window.location.assign so client state
          //     (form input + analysisStore results) resets and the
          //     user actually lands back on a fresh empty home page.
          //
          //   - Anywhere else  : soft client-side navigation, scroll
          //     to top after the route transition kicks in.
          //
          // The Link's href stays "/" so right-click + open-in-new-tab
          // still works correctly.
          onClick={(e) => {
            // Allow modifier-click / middle-click to do their normal thing.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
              return;
            }
            e.preventDefault();
            if (pathname === "/") {
              window.location.assign("/");
              return;
            }
            router.push("/");
            // Scroll to top after the navigation kicks in. Using
            // requestAnimationFrame so it happens after Next's route
            // transition has started painting.
            requestAnimationFrame(() => window.scrollTo({ top: 0 }));
          }}
          className="text-[clamp(18px,1.6vw,24px)] font-semibold text-ink"
          style={{ letterSpacing: "0.24em", lineHeight: 1 }}
        >
          REVENU
        </Link>
        <div className="flex items-center gap-4">
          <a
            href="https://www.revenuagency.io"
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-ink-soft hover:text-ink"
          >
            revenuagency.io ↗
          </a>
          <Link
            href="/reports"
            aria-label={
              count > 0
                ? `Your saved reports (${count})`
                : "Your saved reports"
            }
            title="Your saved reports"
            // Match the green chip styling used on Section header icons.
            // Inactive = soft-green chip (bg-accent-soft + accent-dark icon).
            // Active = solid green (when actually on /reports).
            className={`relative flex h-10 w-10 items-center justify-center rounded-full transition ${
              active
                ? "bg-accent text-white"
                : "bg-accent-soft text-accent-dark hover:bg-accent hover:text-white"
            }`}
          >
            <IconReport className="h-[18px] w-[18px]" />
            {count > 0 && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full"
                style={{ background: "#76A09C", boxShadow: "0 0 0 2px #F8F1E8" }}
              />
            )}
          </Link>
        </div>
      </div>
    </header>
  );
}
