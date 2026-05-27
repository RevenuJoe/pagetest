/**
 * POST /api/analyze
 *
 * Body: { "url": "https://example.com" }
 * Returns: AnalyzeResponse (see /lib/types.ts)
 *
 * Orchestration:
 *   1. Validate the URL.
 *   2. In parallel:
 *      - PSI desktop run
 *      - PSI mobile run
 *      - Raw HTML fetch for structure + text
 *   3. Build the "speed" check from desktop PSI numbers (deterministic).
 *   4. Call Claude once with text + both above-the-fold screenshots,
 *      get back content / digestibility / cro / aboveTheFold / mobile.
 *   5. Return everything as a single JSON payload.
 */

import { NextRequest, NextResponse } from "next/server";
import { runPageSpeed, mergeImprovements } from "@/lib/pagespeed";
import { fetchPage } from "@/lib/fetchPage";
import { analyzeWithClaude } from "@/lib/claude";
import type { AnalyzeResponse, CheckResult } from "@/lib/types";

// Lighthouse can take 30+ seconds. Vercel's default is 10s — we need more.
export const maxDuration = 90;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const url = normalizeUrl(body.url);
  if (!url) {
    return NextResponse.json(
      { error: "Please provide a valid URL (e.g. https://example.com)" },
      { status: 400 },
    );
  }

  try {
    const [desktopRes, mobileRes, page] = await Promise.allSettled([
      runPageSpeed(url, "desktop"),
      runPageSpeed(url, "mobile"),
      fetchPage(url),
    ]);

    // PSI is allowed to fail; we degrade gracefully.
    const desktop =
      desktopRes.status === "fulfilled" ? desktopRes.value : null;
    const mobile =
      mobileRes.status === "fulfilled" ? mobileRes.value : null;

    if (page.status !== "fulfilled") {
      return NextResponse.json(
        {
          error: "Could not fetch the page",
          details: errorMessage(page.reason),
        },
        { status: 502 },
      );
    }
    if (page.value.status >= 400) {
      return NextResponse.json(
        {
          error: `The target site returned HTTP ${page.value.status}.`,
        },
        { status: 502 },
      );
    }

    const speedCheck = buildSpeedCheck(desktop, mobile);

    // Pull screenshots from PSI (already base64-encoded JPEGs, prefixed).
    const desktopShotData = stripDataUrlPrefix(desktop?.finalScreenshot ?? null);
    const mobileShotData = stripDataUrlPrefix(mobile?.finalScreenshot ?? null);

    const ai = await analyzeWithClaude({
      url,
      title: page.value.title,
      metaDescription: page.value.metaDescription,
      bodyText: page.value.bodyText,
      structure: page.value.structure,
      desktopScreenshotB64: desktopShotData,
      mobileScreenshotB64: mobileShotData,
    });

    const checks = {
      speed: speedCheck,
      content: ai.checks.content,
      digestibility: ai.checks.digestibility,
      cro: ai.checks.cro,
      aboveTheFold: ai.checks.aboveTheFold,
      mobile: ai.checks.mobile,
    };

    const overall = Math.round(
      (checks.speed.score +
        checks.content.score +
        checks.digestibility.score +
        checks.cro.score +
        checks.aboveTheFold.score +
        checks.mobile.score) /
        6,
    );

    // Merge desktop + mobile Lighthouse opportunities + diagnostics into
    // one ranked list. Dedupes by audit id, prefers the worse (lower) score
    // so we surface the more urgent reading.
    const technicalImprovements = mergeImprovements(
      desktop?.technicalImprovements ?? [],
      mobile?.technicalImprovements ?? [],
    );

    const response: AnalyzeResponse = {
      url,
      // Cleaned <title> from the scanned page (when present). The saved-reports
      // list uses this as the default report name so users see something
      // meaningful like "Odoo vs Doss — Doss" instead of just "Doss.com".
      pageTitle: page.value.title?.trim() || undefined,
      analyzedAt: new Date().toISOString(),
      overall,
      checks,
      keyTakeaways: ai.keyTakeaways,
      technicalImprovements,
      // Prefer the higher-resolution full-page screenshot when PSI gave us
      // one; otherwise fall back to the viewport-only final screenshot.
      desktopScreenshot:
        desktop?.fullPageScreenshot ?? desktop?.finalScreenshot ?? undefined,
      mobileScreenshot:
        mobile?.fullPageScreenshot ?? mobile?.finalScreenshot ?? undefined,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("analyze failed", err);
    return NextResponse.json(
      {
        error: "Analysis failed",
        details: errorMessage(err),
      },
      { status: 500 },
    );
  }
}

function buildSpeedCheck(
  desktop: { performanceScore: number; lcpMs: number | null; fcpMs: number | null; speedIndexMs: number | null; tbtMs: number | null; cls: number | null } | null,
  mobile: { performanceScore: number; lcpMs: number | null } | null,
): CheckResult {
  if (!desktop && !mobile) {
    return {
      score: 0,
      headline: "PageSpeed Insights could not analyse this URL.",
      notes: [
        "The Lighthouse run failed for both desktop and mobile.",
        "If the site is private or geo-blocked, PSI can't reach it.",
      ],
    };
  }
  // Average desktop + mobile if we got both; otherwise use whichever ran.
  const score = desktop && mobile
    ? Math.round((desktop.performanceScore + mobile.performanceScore) / 2)
    : (desktop?.performanceScore ?? mobile?.performanceScore ?? 0);

  const notes: string[] = [];
  if (desktop) {
    notes.push(
      `Desktop Lighthouse score: ${desktop.performanceScore}/100.`,
    );
    if (desktop.lcpMs != null) {
      notes.push(
        `Largest Contentful Paint (desktop): ${(desktop.lcpMs / 1000).toFixed(2)}s${
          desktop.lcpMs > 2500 ? " — slower than Google's 2.5s target." : "."
        }`,
      );
    }
    if (desktop.tbtMs != null && desktop.tbtMs > 200) {
      notes.push(
        `Total Blocking Time: ${Math.round(desktop.tbtMs)}ms — JavaScript is delaying interactivity.`,
      );
    }
    if (desktop.cls != null && desktop.cls > 0.1) {
      notes.push(
        `Cumulative Layout Shift: ${desktop.cls.toFixed(2)} — content is jumping during load.`,
      );
    }
  }
  if (mobile) {
    notes.push(`Mobile Lighthouse score: ${mobile.performanceScore}/100.`);
    if (mobile.lcpMs != null) {
      notes.push(
        `Largest Contentful Paint (mobile): ${(mobile.lcpMs / 1000).toFixed(2)}s.`,
      );
    }
  }

  const headline =
    score >= 90
      ? "Page loads fast on both desktop and mobile."
      : score >= 75
      ? "Load speed is solid but has room to improve."
      : score >= 50
      ? "Load speed is mediocre — visitors will feel the lag."
      : "Page is slow enough to hurt conversions.";

  return { score, headline, notes };
}

function stripDataUrlPrefix(s: string | null): string | null {
  if (!s) return null;
  return s.startsWith("data:") ? s.replace(/^data:[^;]+;base64,/, "") : s;
}

function normalizeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
