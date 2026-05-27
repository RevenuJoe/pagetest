import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  // Matches the "Revenu · …" middle-dot pattern used across revenuagency.io.
  title: "Revenu · the landing page tester",
  description:
    "Score any landing page in 60 seconds. Speed, content, digestibility, CRO, above-the-fold and mobile, all scored automatically.",
  metadataBase: new URL("https://pages.revenuagency.io"),
  // Favicons match library.revenuagency.io exactly.
  icons: {
    icon: [
      { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/favicon/favicon-180.png", sizes: "180x180" }],
    shortcut: "/favicon/favicon.ico",
  },
  openGraph: {
    title: "Revenu · the landing page tester",
    description:
      "Instant six-point health check for any web page. Powered by Lighthouse and Claude.",
    url: "https://pages.revenuagency.io",
    siteName: "Revenu",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&display=swap"
        />
      </head>
      <body className="font-sans antialiased bg-bg text-ink">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
