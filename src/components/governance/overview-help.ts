/**
 * What each Technical context field is for.
 *
 * The website facts above are read-only values from onboarding and speak for
 * themselves; only the fields a person fills in carry guidance.
 */
export const TECHNICAL_HELP: Record<string, string> = {
  hostingNotes:
    "Where the site runs and anything unusual about it — CDN, edge rules, redirects handled outside the CMS.",
  knownMigrations:
    "Replatforms, domain moves or URL restructures, with rough dates. Traffic changes around these dates have a known cause.",
  knownConstraints:
    "What cannot be changed, and why. Templates you do not control, legal review requirements, a release train you have to fit into.",
  stagingAvailable:
    "Whether there is a non-production environment to test changes in. Leave unanswered if you are not sure — it stays unknown rather than being recorded as no.",
  developerContact: "Who to reach for technical changes. A name or team is enough.",
  publicationProcess:
    "What has to happen for a page to go live — who writes, who reviews, who approves, who publishes.",
  technicalNotes:
    "Anything else a person joining this website would need to know. Facts only; SEO OS makes no assessment of technical health in this phase.",
};

/**
 * Verification is the one read-only fact that does need explaining: its value is
 * about a capability that does not exist yet, so without this the row reads as a
 * problem with the website rather than a phase boundary.
 */
export const VERIFICATION_HELP =
  "Whether ownership of this domain has been proven — that the site is yours, not just a domain typed into a form. Nothing verifies it in this phase. It is confirmed in P1 by connecting Google Search Console, which only returns data for properties you already own.";

/**
 * The website's own facts, now editable, so they carry guidance like any other form.
 */
export const WEBSITE_FIELD_HELP: Record<string, string> = {
  additionalMarkets:
    "Other countries this site is trying to win, up to five. Set during onboarding or in the Business Context; the main market is the one keyword data and the connectors use.",
  domain:
    "The address SEO OS operates on. Scheme, www, port, path and trailing dots are stripped, so one site keeps one identity. Changing this changes which site everything below refers to.",
  name: "A human label used in headings and reports. It has no effect on SEO work.",
  websiteType:
    "What kind of site this is. It shapes which conversions and page patterns matter in later phases.",
  cmsType:
    "What the site is built on. Determines which publishing integrations become possible later.",
  primaryMarket:
    "The country you are trying to win, chosen from the list. Keyword identity and the Semrush and Ahrefs connectors both key off this, so it is a country code rather than a description.",
  primaryLanguage: "The language this website publishes in.",
  timezone:
    "Used to align reporting periods. Search data is reported in its own timezone, so a mismatch shifts day boundaries.",
};

/**
 * Placeholders for the Technical context form.
 *
 * As with goals, these are one site's story told across every field rather than
 * five unrelated samples — the hosting choice, the migration it went through, the
 * constraint that follows from it, and the process that results. The relationships
 * are the useful part: a migration date explains a traffic change, and a shared
 * template explains why a fix is not simply available.
 *
 * Guidance only. Nothing here is ever submitted.
 */
export const TECHNICAL_PLACEHOLDERS = {
  hostingNotes: "Webflow hosting behind Cloudflare; redirects managed in Cloudflare, not the CMS",
  knownMigrations:
    "WordPress to Webflow, March 2024. Blog URLs changed from /blog/YYYY/MM/slug to /blog/slug",
  knownConstraints:
    "Blog templates are shared with the marketing site and cannot be changed independently. Pricing copy needs legal sign-off",
  developerContact: "Platform team — platform@example.com",
  publicationProcess:
    "Draft in Webflow, content lead reviews, legal reviews anything with a price, publish on Tuesdays",
  technicalNotes:
    "Search Console is verified on the www property only; the apex domain redirects to it",
} as const;
