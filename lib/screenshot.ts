/**
 * High-resolution screenshot fetcher.
 *
 * Lighthouse's PSI screenshots are JPEG-compressed at ~50 quality and capped
 * at the device-emulation viewport (1350px desktop / 412px mobile). On Retina
 * displays they look blurry after the browser scales them up.
 *
 * This module calls Microlink's free screenshot API in parallel with PSI to
 * fetch crisp full-page screenshots at 2x device-pixel-ratio. We use the
 * result for the displayed images on the report. Microlink's free tier
 * allows ~50 requests/day per IP — if we get rate-limited or anything else
 * fails, the caller falls back to PSI's base64 image so the tool keeps
 * working.
 */
export interface MicrolinkScreenshot {
  /** Public URL to the high-res image, served from Microlink's CDN. */
  url: string;
  /** Pixel dimensions of the captured image. */
  width: number;
  height: number;
}

interface MicrolinkResponse {
  status?: string;
  message?: string;
  data?: {
    screenshot?: {
      url?: string;
      width?: number;
      height?: number;
    };
  };
}

/**
 * Microlink has two endpoints:
 *
 * - `https://api.microlink.io/` — anonymous / free tier. Shared IP rate
 *   limit (~50/day per IP). Sending `x-api-key` here is invalid and the
 *   request is rejected with HTTP 400 at validation time.
 * - `https://pro.microlink.io/` — paid tier. Requires `x-api-key` header.
 *   This is what the Microlink docs use in every authenticated example.
 *
 * We pick the right endpoint at call time based on whether
 * MICROLINK_API_KEY is set, so the code keeps working in development
 * without the env var and uses the paid quota in production.
 */
const MICROLINK_ANON_ENDPOINT = "https://api.microlink.io/";
const MICROLINK_PRO_ENDPOINT = "https://pro.microlink.io/";

/** Which kind of capture to request from Microlink. */
export type ScreenshotMode = "atf" | "fullpage";

/**
 * Capture a single screenshot via Microlink for one device strategy.
 *
 * - `desktop` viewport: 1440×900, deviceScaleFactor 2.
 * - `mobile`  viewport: 390×844 (iPhone 14-ish), deviceScaleFactor 2.
 *
 * Modes:
 * - `atf`      — above-the-fold only (initial visible viewport). Used in
 *                the Overview thumbnail and the AtF Screenshots section.
 * - `fullpage` — the entire scrolled page (Microlink stitches the capture
 *                top-to-bottom). Used in the Full Page Screenshot section.
 *                Takes longer than AtF (typically 15-30s on heavy pages).
 *
 * `type=jpeg` is what we request from Microlink. Their API only accepts
 * `'jpeg' | 'png'` per the docs — `webp` is NOT a valid value and gets
 * rejected with HTTP 400 at validation time. The image is still served
 * as WebP to modern browsers because Microlink's CDN does automatic
 * format negotiation based on the request's `Accept` / `User-Agent`
 * headers, so the size + quality benefit is preserved.
 *
 * `waitUntil=load` captures as soon as the initial HTML/CSS/images are
 * ready. We deliberately avoid `networkidle0` because marketing sites
 * with analytics polling, web sockets, or chat widgets can NEVER reach
 * idle, which makes Microlink hang on them for the full timeout.
 *
 * Hard timeout of 45s per call — Joe values Microlink's high-quality
 * images enough to wait for them rather than fall back to lower-res
 * PSI screenshots.
 *
 * Returns null on ANY failure (rate-limit, timeout, parse error) so the
 * caller can fall back gracefully.
 */
export async function fetchMicrolinkScreenshot(
  url: string,
  strategy: "desktop" | "mobile",
  mode: ScreenshotMode = "atf",
): Promise<MicrolinkScreenshot | null> {
  try {
    const params = new URLSearchParams({
      url,
      screenshot: "true",
      meta: "false",
      // Microlink only accepts 'jpeg' | 'png' for the capture format.
      // We request jpeg; the CDN re-encodes to WebP via Accept-header
      // negotiation when the browser asks for it.
      type: "jpeg",
      // Above-the-fold = false (capture just the visible viewport on
      // page load). Full page = true (stitch the whole scroll).
      // Microlink's public API was observed returning full-page
      // captures even when fullPage was omitted, so we always set it
      // explicitly to the value we want.
      fullPage: mode === "fullpage" ? "true" : "false",
      // Microlink caches by URL aggressively (default TTL 12h+) and the
      // cache key does NOT include screenshot params like fullPage. So a
      // URL that was previously captured with fullPage=true keeps
      // returning the old 15000px image. force=true bypasses the cache
      // and gives us a fresh capture every run — which is what a page
      // TESTER wants anyway (current state of the live page).
      force: "true",
      // `load` fires when the DOM load event triggers. We deliberately
      // do NOT use `networkidle0` (zero connections for 500ms) because
      // marketing sites with analytics polling, web sockets, or chat
      // widgets can NEVER reach idle, which makes Microlink hang on
      // them for the full 25s timeout. `load` captures the
      // above-the-fold view as soon as the initial HTML/CSS/images are
      // ready, which is what we want.
      waitUntil: "load",
    });

    if (strategy === "desktop") {
      params.set("viewport.width", "1440");
      params.set("viewport.height", "900");
      params.set("viewport.deviceScaleFactor", "2");
    } else {
      // iPhone 14-ish viewport. isMobile triggers mobile UA + touch events.
      params.set("viewport.width", "390");
      params.set("viewport.height", "844");
      params.set("viewport.deviceScaleFactor", "2");
      params.set("viewport.isMobile", "true");
    }

    // Optional Microlink API key. When set, the request goes against
    // the project's paid quota instead of the anonymous IP-based bucket
    // (which is small and shared with everyone else on the same exit
    // IP — easy to exhaust, especially behind a VPN). Microlink reads
    // the key from the `x-api-key` header AND routes paid traffic
    // through a different hostname (pro.microlink.io) — sending the
    // header to api.microlink.io is rejected with HTTP 400.
    const headers: Record<string, string> = {
      "user-agent": "pagetest-revenuagency.io",
    };
    const microlinkKey = process.env.MICROLINK_API_KEY;
    if (microlinkKey) headers["x-api-key"] = microlinkKey;
    const endpoint = microlinkKey
      ? MICROLINK_PRO_ENDPOINT
      : MICROLINK_ANON_ENDPOINT;

    const res = await fetch(`${endpoint}?${params.toString()}`, {
      // 45s ceiling. Joe specifically values Microlink's high-quality
      // screenshots and would rather wait than fall back to PSI's lower
      // resolution images. Still fits inside the route's maxDuration
      // (270s) alongside the parallel PSI runs.
      signal: AbortSignal.timeout(45_000),
      headers,
    });

    if (!res.ok) {
      // Read the response body so we can see WHY Microlink rejected
      // the call. They return JSON like `{ status: "fail",
      // message: "<reason>", code: "<short_id>" }`. The HTTP status
      // text alone (e.g. "Bad Request") tells us nothing — the
      // message field is the actionable bit. We also include `mode`
      // in the log so AtF failures are distinguishable from full-page
      // failures.
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        bodyText = "(failed to read body)";
      }
      const hasKey = process.env.MICROLINK_API_KEY ? "with-key" : "no-key";
      console.warn(
        `Microlink ${strategy}/${mode} (${hasKey}) returned ${res.status} ${res.statusText} for ${url} — body: ${bodyText.slice(0, 600)}`,
      );
      return null;
    }

    const body = (await res.json()) as MicrolinkResponse;
    if (body.status !== "success" || !body.data?.screenshot?.url) {
      console.warn(
        `Microlink ${strategy} response missing screenshot URL for ${url}: ${body.message ?? body.status}`,
      );
      return null;
    }

    return {
      url: body.data.screenshot.url,
      width: body.data.screenshot.width ?? 0,
      height: body.data.screenshot.height ?? 0,
    };
  } catch (err) {
    console.warn(
      `Microlink ${strategy} failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
