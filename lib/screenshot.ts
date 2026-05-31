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
    // NOTE on parameter style: dot notation (viewport.width=1440,
    // screenshot.fullPage=true, screenshot.type=jpeg) is the form
    // Microlink's public docs use and the only form their qs-style
    // parser actually honours on pro.microlink.io. Bracket notation
    // (viewport[width], screenshot[type]) was tested and silently
    // falls back to defaults.
    //
    // BUT: a critical subtlety the docs imply but don't spell out — a
    // SCALAR `screenshot=true` blocks the parser from binding any
    // NESTED `screenshot.X` sub-keys. Every fullPage example in the
    // docs sends `screenshot.fullPage=true` alone, NEVER alongside a
    // bare `screenshot=true`. So we set the `screenshot` capability
    // toggle differently per mode:
    //   - atf:      bare `screenshot=true` (no sub-params needed)
    //   - fullpage: nested `screenshot.fullPage=true` + `screenshot.type=jpeg`,
    //               and we DO NOT also send a bare `screenshot=true`.
    const params = new URLSearchParams({
      url,
      meta: "false",
      // Microlink caches by URL aggressively (default TTL 12h+) so we
      // bypass the cache for every run.
      force: "true",
      // `load` fires when the DOM load event triggers. We deliberately
      // avoid `networkidle0` because marketing sites with analytics
      // polling, web sockets, or chat widgets can NEVER reach idle,
      // which makes Microlink hang for the full timeout.
      waitUntil: "load",
    });

    if (mode === "fullpage") {
      // Nested form ONLY. `screenshot.fullPage=true` implicitly
      // enables the screenshot capability; the bare flag would
      // override it as a scalar and the sub-key would be discarded.
      params.set("screenshot.fullPage", "true");
      params.set("screenshot.type", "jpeg");
    } else {
      // Scalar form for plain AtF — no `screenshot.X` sub-params in
      // play, so bare `screenshot=true` + bare `type=jpeg` is fine and
      // matches the docs Overview example.
      params.set("screenshot", "true");
      params.set("type", "jpeg");
    }

    if (strategy === "desktop") {
      // Custom desktop viewport at 2× DPR for crisp Retina output.
      params.set("viewport.width", "1440");
      params.set("viewport.height", "900");
      params.set("viewport.deviceScaleFactor", "2");
    } else {
      // For mobile we use Microlink's `device` parameter — a documented
      // preset that maps to Puppeteer's device descriptors. The preset
      // sets the viewport, deviceScaleFactor, isMobile, hasTouch flags
      // AND a real iPhone Safari User-Agent in one go. This is the
      // reliable way to get a true mobile render: previously we set
      // viewport.isMobile=true alone, which only fires CSS media
      // queries — sites that switch HTML at the edge based on the
      // User-Agent (Cloudflare device detection, Next.js middleware,
      // SSR frameworks) kept sending desktop HTML, so the capture
      // showed the desktop layout shrunk into a phone-sized viewport.
      // "iPhone 14 Pro Max" is one of Puppeteer's modern presets
      // (390×844 @ 3×) — the closest match to a current iPhone that's
      // in the standard descriptor list.
      params.set("device", "iPhone 14 Pro Max");
    }

    // Full-page capture: empirically the screenshot.fullPage param is
    // ignored by Microlink Pro regardless of dot or bracket form, so
    // /api/analyze no longer calls this function with mode="fullpage"
    // (the UI section was hidden and the call always returned an AtF
    // crop anyway). The block is left here in case a future Microlink
    // change makes it honoured again.
    if (mode === "fullpage") {
      params.set("screenshot.fullPage", "true");
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
        `Microlink ${strategy}/${mode} response missing screenshot URL for ${url}: ${body.message ?? body.status}`,
      );
      return null;
    }

    // Log the returned image URL + pixel dimensions on success so we
    // can verify in Vercel logs that fullpage captures are actually
    // taller than AtF crops. A real fullpage capture is typically
    // 3000-15000px tall; AtF crops match the viewport (~900 desktop
    // / 844 mobile at 2× DPR).
    console.log(
      `Microlink ${strategy}/${mode} OK ${body.data.screenshot.width}x${body.data.screenshot.height} → ${body.data.screenshot.url}`,
    );

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
