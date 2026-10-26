import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://trymoa.work"),
  title: "moa: a mixture of accountants",
  description: "An autonomous AP and cost team for AI lab compute spend.",
  openGraph: {
    title: "moa: a mixture of accountants",
    description: "An autonomous AP and cost team for AI lab compute spend.",
    url: "/",
    siteName: "moa",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  colorScheme: "only light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable + " h-full antialiased"}>
      <head>
        <meta name="darkreader-lock" />
      </head>
      <body className="h-full overflow-hidden font-sans">{children}</body>
    </html>
  );
}
