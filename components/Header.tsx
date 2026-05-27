"use client";

import Link from "next/link";
import { IconReport } from "@/components/Icons";
import { useSavedReports } from "@/lib/storeHooks";

export default function Header({ active = false }: { active?: boolean }) {
  const saved = useSavedReports();
  const count = saved.length;
  return (
    <header className="px-6 py-5 sm:px-14">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-6">
        <Link
          href="/"
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
            className={`relative flex h-9 w-9 items-center justify-center rounded-full border transition ${
              active
                ? "border-accent bg-accent text-white"
                : "border-beige-line bg-card text-ink-soft hover:text-ink"
            }`}
          >
            <IconReport />
            {count > 0 && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg"
                style={{ background: "#22c55e" }}
              />
            )}
          </Link>
        </div>
      </div>
    </header>
  );
}
