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
  developerContact:
    "Who to reach for technical changes. A name or team is enough.",
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
