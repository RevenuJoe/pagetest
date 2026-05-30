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

const MICROLINK_ENDPOINT = "https://api.microlink.io/";

/**
 * Capture a single screenshot via Microlink for one device strategy.
 *
 * - `desktop` → 1440×900 viewport, deviceScaleFactor 2, ABOVE-THE-FOLD only.
 * - `mobile`  → 390×844 viewport, deviceScaleFactor 2, ABOVE-THE-FOLD only.
 *
 * We deliberately do NOT pass fullPage so Microlink only captures the
 * initial visible viewport. Joe wants the report to show what a visitor
 * sees the moment the page loads, not a 5000px stitched scroll capture.
 *
 * `waitUntil=load` captures as soon as the initial HTML/CSS/images are
 * ready, which is the right trade-off for an above-the-fold view. Hard
 * timeout of 45s per call — Joe values Microlink's high-quality images
 * enough to wait for them rather than fall back to lower-res PSI.
 *
 * Returns null on ANY failure (rate-limit, timeout, parse error) so the
 * caller can fall back gracefully.
 */
export async function fetchMicrolinkScreenshot(
  url: string,
  strategy: "desktop" | "mobile",
): Promise<MicrolinkScreenshot | null> {
  try {
    const params = new URLSearchParams({
      url,
      screenshot: "true",
      meta: "false",
      type: "jpeg",
      // EXPLICITLY false. Microlink's public API was observed returning
      // full-page captures when this isn't set, despite the documented
      // default. We want above-the-fold only.
      fullPage: "false",
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

    // Optional Microlink API key. When set, the request goes against the
    // project's paid quota instead of the anonymous IP-based bucket
    // (which is small and shared with everyone else on the same exit
    // IP — easy to exhaust, especially behind a VPN). Microlink reads
    // the key from the `x-api-key` header per their docs.
    const headers: Record<string, string> = {
      "user-agent": "pagetest-revenuagency.io",
    };
    const microlinkKey = process.env.MICROLINK_API_KEY;
    if (microlinkKey) headers["x-api-key"] = microlinkKey;

    const res = await fetch(`${MICROLINK_ENDPOINT}?${params.toString()}`, {
      // 45s ceiling. Joe specifically values Microlink's high-quality
      // screenshots and would rather wait than fall back to PSI's lower
      // resolution images. Still fits inside the route's maxDuration
      // (270s) alongside the parallel PSI runs.
      signal: AbortSignal.timeout(45_000),
      headers,
    });

    if (!res.ok) {
      // 429 = rate-limited (free tier), 5xx = Microlink trouble.
      console.warn(
        `Microlink ${strategy} returned ${res.status} ${res.statusText} for ${url}`,
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
