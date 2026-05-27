import type { Metadata } from "next";

// /reports is a per-user UI (saved reports live in the user's localStorage),
// so there's nothing useful for search engines to index here. We still give
// it a title so the browser tab makes sense.
export const metadata: Metadata = {
  title: "Your saved reports",
  description:
    "Your saved landing page reports, stored locally in your browser. Open, rename, rerun, or delete them.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  alternates: { canonical: "https://pages.revenuagency.io/reports" },
};

export default function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
