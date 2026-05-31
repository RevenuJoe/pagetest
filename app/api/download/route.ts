/**
 * Server-side proxy for downloading screenshot files to the user's
 * computer. The Microlink CDN sometimes serves images without the
 * permissive CORS headers a browser needs to fetch + save the bytes
 * client-side, and even when it does send them, browsers honour the
 * `download` attribute on an <a> tag only when the response also sends
 * a matching Content-Disposition. Routing through our own /api proxy
 * lets us:
 *
 *   1. Fetch the bytes server-side, where CORS doesn't apply.
 *   2. Set Content-Disposition: attachment; filename="..." on the way
 *      back, so the browser actually saves the file instead of
 *      opening it inline.
 *   3. Sanitise the filename and the source URL so the route can't
 *      be used as an open proxy for arbitrary destinations.
 *
 * Usage from the client:
 *   /api/download?url=<encoded-microlink-url>&filename=<safe-name>.webp
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// Downloading a single full-page WebP can take up to ~30s on slow
// Microlink renders, so give the function plenty of headroom.
export const maxDuration = 60;

/** Allowed source hosts for the proxy. Restricting to Microlink stops
 *  this route being used as a general open proxy. */
const ALLOWED_HOSTS = new Set<string>([
  "api.microlink.io",
  "pro.microlink.io",
  // Microlink's CDN edges. The hostname pattern is `<region>.microlink.io`.
  // We accept any `*.microlink.io` host below.
]);

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host) || host.endsWith(".microlink.io");
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl?.searchParams;
  const rawUrl = params?.get("url");
  const rawFilename = params?.get("filename") ?? "screenshot.webp";

  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  if (!/^https?:$/.test(target.protocol)) {
    return NextResponse.json({ error: "Only http(s) urls allowed" }, { status: 400 });
  }

  if (!isAllowedHost(target.hostname)) {
    return NextResponse.json(
      { error: `Host not allowed for download proxy: ${target.hostname}` },
      { status: 400 },
    );
  }

  // Sanitise the filename: strip path separators, control chars, and
  // anything else that looks dodgy. Force a .webp extension if the
  // caller didn't provide one — that's the format Microlink's CDN
  // serves to modern browsers via Accept-header negotiation.
  let filename = rawFilename
    .replace(/[\\/\x00-\x1f"<>|]+/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (filename.length === 0) filename = "screenshot.webp";
  if (!/\.[a-z0-9]{2,4}$/i.test(filename)) filename = `${filename}.webp`;

  try {
    const upstream = await fetch(target.toString(), {
      // 50s ceiling so a slow Microlink render can't pin the function
      // up to its maxDuration.
      signal: AbortSignal.timeout(50_000),
      // No credentials, no cookies. Pretend to be a regular browser
      // so the CDN serves the WebP variant via UA-based negotiation.
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "image/webp,image/*,*/*;q=0.8",
      },
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `Upstream returned ${upstream.status}` },
        { status: 502 },
      );
    }

    // Forward the bytes. Pin Content-Type to the upstream value when
    // present; otherwise default to image/webp because the CDN ought
    // to be serving WebP given our Accept header. Content-Disposition
    // is what makes the browser actually save the file.
    const contentType = upstream.headers.get("content-type") ?? "image/webp";
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        // Long cache: the Microlink URL is content-addressed (the
        // hash changes when the page changes), so the proxied bytes
        // never change for a given URL.
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    console.warn(
      `/api/download failed for ${target.toString()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NextResponse.json(
      { error: "Download proxy failed" },
      { status: 502 },
    );
  }
}
