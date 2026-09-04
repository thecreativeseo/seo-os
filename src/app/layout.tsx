import type { Metadata } from "next";
import { Google_Sans, Google_Sans_Code } from "next/font/google";
import "./globals.css";

// Every page renders per request, never at build time. This is an
// authenticated dashboard: what a page shows depends on who is asking, and
// several pages read environment that a build must not need. Static
// prerendering would bake build-time secrets into HTML, or fail without them -
// it did, three routes in a row - and there is nothing here worth caching.
export const dynamic = "force-dynamic";

/**
 * Type system.
 *
 * Google Sans for the interface, Google Sans Code for anything that must line up
 * or be read literally — domains, ids, metric values. Both are served through
 * next/font, so the files are self-hosted at build time: no request to a Google
 * domain at runtime, and no layout shift while a webfont loads.
 *
 * Variable weights (400–700) rather than fixed cuts, so headings and labels can
 * differ in weight without shipping extra files.
 */
const googleSans = Google_Sans({
  variable: "--font-google-sans",
  subsets: ["latin"],
  display: "swap",
  weight: "variable",
});

const googleSansCode = Google_Sans_Code({
  variable: "--font-google-sans-code",
  subsets: ["latin"],
  display: "swap",
  weight: "variable",
});

export const metadata: Metadata = {
  title: "SEO OS",
  description: "Build the context your SEO team operates from.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${googleSans.variable} ${googleSansCode.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* First thing in the tab order, so keyboard users can pass the sidebar. */}
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <div id="main-content" className="flex min-h-full flex-1 flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
