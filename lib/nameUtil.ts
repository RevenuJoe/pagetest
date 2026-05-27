/**
 * Derive a friendly default report name from a URL.
 *
 *   https://www.dos.com/         → Dos.com
 *   https://udos.com/pricing      → Udos.com
 *   https://blog.acme.io/posts/1  → Blog.acme.io
 *   https://example.co.uk         → Example.co.uk
 *
 * The hostname is lower-cased by the URL parser, so we just strip the `www.`
 * prefix and upper-case the first character. We don't try to title-case the
 * whole thing because that breaks domains like `co.uk` and looks worse than
 * the simple single-capital form.
 */
export function deriveReportName(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    if (host.length === 0) return url;
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch {
    return url;
  }
}

/** Best display name for a report: user-edited if present, otherwise derived. */
export function displayName(report: { url: string; name?: string }): string {
  if (report.name && report.name.trim().length > 0) return report.name;
  return deriveReportName(report.url);
}
