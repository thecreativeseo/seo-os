import type { Metadata } from "next";
import { Google_Sans, Google_Sans_Code } from "next/font/google";
import "./globals.css";

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
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
