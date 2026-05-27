import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const SITE_URL = "https://pages.revenuagency.io";
const SITE_NAME = "Revenu";
const TITLE = "Landing Page Tester | Revenu";
const DESCRIPTION =
  "Score any landing page in 60 seconds. Speed, content, digestibility, CRO, above-the-fold and mobile, all scored automatically by Google Lighthouse and Claude. Built by Revenu Agency.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    // When a child route sets its own title via `metadata.title`, the layout's
    // template wraps it with " | Revenu" for consistency. The home page sets
    // an absolute title so this template is only used by other routes.
    template: "%s | Revenu",
  },
  description: DESCRIPTION,
  keywords: [
    "landing page test",
    "landing page analysis",
    "page speed test",
    "Google PageSpeed Insights",
    "Lighthouse audit",
    "above the fold analysis",
    "conversion rate optimisation",
    "CRO audit",
    "mobile layout test",
    "Claude AI page review",
    "Revenu Agency",
    "B2B SaaS landing page",
    "page optimisation tool",
  ],
  authors: [{ name: "Revenu Agency", url: "https://www.revenuagency.io" }],
  creator: "Revenu Agency",
  publisher: "Revenu Agency",
  category: "Marketing tools",
  applicationName: "Landing Page Tester",

  // Favicons match library.revenuagency.io exactly.
  icons: {
    icon: [
      { url: "/favicon/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/favicon/favicon-180.png", sizes: "180x180" }],
    shortcut: "/favicon/favicon.ico",
  },

  alternates: {
    canonical: SITE_URL,
    types: {
      "text/plain": [{ url: "/llms.txt", title: "LLM context (short)" }],
      "text/markdown": [
        { url: "/llms-full.txt", title: "LLM context (full)" },
      ],
    },
  },

  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    type: "website",
    locale: "en_GB",
    images: [
      {
        url: "/favicon/favicon-192.png",
        width: 192,
        height: 192,
        alt: "Revenu",
      },
    ],
  },

  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/favicon/favicon-192.png"],
    creator: "@revenuagency",
  },

  robots: {
    index: true,
    follow: true,
    "max-snippet": -1,
    "max-image-preview": "large",
    "max-video-preview": -1,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },

  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#FCF7F5",
  width: "device-width",
  initialScale: 1,
};

/**
 * Site-wide JSON-LD: Organization, WebSite, and the SoftwareApplication that
 * represents the tester itself. Helps search engines and AI tools understand
 * what this site IS, who built it, and how to attribute it.
 */
const siteJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.revenuagency.io/#organization",
      name: "Revenu",
      alternateName: "Revenu Agency",
      url: "https://www.revenuagency.io",
      logo: `${SITE_URL}/favicon/favicon-192.png`,
      sameAs: [],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: DESCRIPTION,
      publisher: { "@id": "https://www.revenuagency.io/#organization" },
      inLanguage: "en-GB",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: "Landing Page Tester",
      description: DESCRIPTION,
      url: SITE_URL,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      provider: { "@id": "https://www.revenuagency.io/#organization" },
      featureList: [
        "Google PageSpeed Insights audit",
        "Lighthouse performance scores for desktop and mobile",
        "Claude-powered content quality review",
        "Digestibility and information hierarchy scoring",
        "Conversion rate optimisation (CRO) assessment",
        "Above-the-fold analysis",
        "Mobile layout review",
        "Prioritised key takeaways with concrete recommendations",
        "Auto-saved reports with rename and rerun",
      ],
    },
  ],
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
        {/* Site-wide structured data (Organization + WebSite + SoftwareApplication) */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd) }}
        />
      </head>
      <body className="font-sans antialiased bg-bg text-ink">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
