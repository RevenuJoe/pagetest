/**
 * Module-level singleton for the user's saved reports.
 *
 * Backs onto localStorage and broadcasts change events so multiple pages
 * (e.g. / and /reports) stay in sync without prop-drilling. Components
 * subscribe via `useSavedReports()` (see ./useSavedReports.ts).
 */

import type { AnalyzeResponse } from "./types";

const KEY = "pagetest-saved-reports-v1";
const MAX = 15;

// We keep an in-memory cache to avoid re-parsing localStorage on every read,
// and to keep multiple components mounted in the same tab in sync without
// each one running its own listener.
let cache: AnalyzeResponse[] | null = null;
const listeners = new Set<() => void>();

function ensure(): AnalyzeResponse[] {
  if (typeof window === "undefined") return [];
  if (cache !== null) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as AnalyzeResponse[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  if (typeof window === "undefined" || cache === null) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Quota error — silently drop. The in-memory cache still holds the data
    // for the rest of the session.
  }
  for (const fn of listeners) fn();
}

export const savedStore = {
  list(): AnalyzeResponse[] {
    return ensure();
  },
  find(url: string): AnalyzeResponse | undefined {
    return ensure().find((r) => r.url === url);
  },
  /** Save (or overwrite) a report. Dedupes by URL, caps the list at MAX. */
  save(report: AnalyzeResponse) {
    const list = ensure();
    const deduped = list.filter((r) => r.url !== report.url);
    cache = [report, ...deduped].slice(0, MAX);
    persist();
  },
  rename(url: string, name: string) {
    const list = ensure();
    const trimmed = name.trim();
    cache = list.map((r) =>
      r.url === url
        ? { ...r, name: trimmed.length > 0 ? trimmed : undefined }
        : r,
    );
    persist();
  },
  remove(url: string) {
    const list = ensure();
    cache = list.filter((r) => r.url !== url);
    persist();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
