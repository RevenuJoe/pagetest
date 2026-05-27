/**
 * React hooks for the savedStore and analysisStore singletons.
 *
 * Both stores use a subscribe/notify pattern; these hooks adapt that into
 * standard React state so components re-render on changes.
 */

"use client";

import { useEffect, useReducer, useState } from "react";
import { savedStore } from "./savedStore";
import { analysisStore, type ActiveRun } from "./analysisStore";
import type { AnalyzeResponse } from "./types";

export function useSavedReports(): AnalyzeResponse[] {
  // Snapshot the current list; re-run on any change broadcast by the store.
  const [list, setList] = useState<AnalyzeResponse[]>(() => savedStore.list());
  useEffect(() => {
    setList(savedStore.list().slice());
    return savedStore.subscribe(() => setList(savedStore.list().slice()));
  }, []);
  return list;
}

export function useActiveRun(url: string | null | undefined): ActiveRun | undefined {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    return analysisStore.subscribe(() => force());
  }, []);
  return url ? analysisStore.get(url) : undefined;
}

export function useRunningUrls(): Set<string> {
  const [running, setRunning] = useState<Set<string>>(() =>
    analysisStore.runningUrls(),
  );
  useEffect(() => {
    setRunning(analysisStore.runningUrls());
    return analysisStore.subscribe(() => setRunning(analysisStore.runningUrls()));
  }, []);
  return running;
}
