/**
 * Module-level singleton for in-flight page analyses.
 *
 * The whole point: a rerun kicked off on /reports can still be tracked by /
 * after the user clicks "Open" on the rerunning row. The fetch lives here
 * in module scope so it survives client-side navigation.
 *
 * Lifecycle:
 *   start(url) → state "running"
 *      ↓
 *   fetch completes → state "done" + result, also saved to savedStore
 *      ↓
 *   clear(url) — caller drops it once they've consumed the result
 *
 *   (or fetch fails → state "error" + error message)
 */

import type { AnalyzeResponse } from "./types";
import { savedStore } from "./savedStore";

export type RunState = "running" | "done" | "error";

export interface ActiveRun {
  url: string;
  state: RunState;
  startedAt: number;
  result?: AnalyzeResponse;
  error?: string;
}

const active = new Map<string, ActiveRun>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export const analysisStore = {
  get(url: string): ActiveRun | undefined {
    return active.get(url);
  },
  isRunning(url: string): boolean {
    return active.get(url)?.state === "running";
  },
  /** Start an analysis for `url`. If one is already running for that URL,
   *  the call is a no-op (returns the existing run). The fetch happens
   *  asynchronously; callers should subscribe() to see state changes. */
  start(url: string, opts?: { preserveName?: string }): ActiveRun {
    const existing = active.get(url);
    if (existing?.state === "running") return existing;
    const run: ActiveRun = { url, state: "running", startedAt: Date.now() };
    active.set(url, run);
    notify();
    void (async () => {
      try {
        // Forward `?debug=1` from the page URL through to the API
        // call. When set, the response includes a `criticVerdicts`
        // log + a `debugTrace` capturing the content at every
        // pipeline phase plus what was removed at each phase. Used
        // by the in-page "Stage trace" inspector for tuning.
        const debugFlag =
          typeof window !== "undefined" &&
          (new URLSearchParams(window.location.search).get("debug") === "1" ||
            new URLSearchParams(window.location.search).get("debug") === "true");
        const endpoint = debugFlag ? "/api/analyze?debug=1" : "/api/analyze";
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || "Analysis failed");
        }
        const result = body as AnalyzeResponse;
        if (opts?.preserveName) result.name = opts.preserveName;
        active.set(url, { ...run, state: "done", result });
        // Persist to saved-reports list immediately so any consumer (e.g. a
        // page that loads from savedStore) gets the new data even before
        // they subscribe to this store.
        savedStore.save(result);
        notify();
      } catch (err) {
        active.set(url, {
          ...run,
          state: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        notify();
      }
    })();
    return run;
  },
  /** Drop a completed run from the store. Call this after the UI has
   *  consumed the result so the next attempt isn't treated as a duplicate. */
  clear(url: string) {
    active.delete(url);
    notify();
  },
  /** All currently-running URLs (used to highlight rows in the saved list). */
  runningUrls(): Set<string> {
    const out = new Set<string>();
    for (const [url, run] of active) {
      if (run.state === "running") out.add(url);
    }
    return out;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
