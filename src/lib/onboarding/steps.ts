/**
 * Onboarding step order (docs/P0_SPEC.md §10, blueprint "Onboarding progress").
 *
 * The order is data, not layout: the server validates every navigation and save
 * against this list, so a user cannot skip ahead by editing the URL.
 */

export const ONBOARDING_STEPS = [
  { slug: "website", index: 1, label: "Website", title: "What website are we operating on?" },
  { slug: "business", index: 2, label: "Business", title: "What does this website sell or support?" },
  { slug: "customer", index: 3, label: "Customer", title: "Who is your primary customer?" },
  { slug: "conversion", index: 4, label: "Conversion", title: "What action matters most?" },
  { slug: "market", index: 5, label: "Market", title: "Where are you trying to win?" },
  { slug: "competitors", index: 6, label: "Competitors", title: "Who do you compete with?" },
  { slug: "goals", index: 7, label: "Goals", title: "What does SEO need to help the business accomplish?" },
  { slug: "seo-priorities", index: 8, label: "SEO Priorities", title: "Where should SEO focus?" },
  { slug: "cms", index: 9, label: "CMS", title: "What is this website built on?" },
  { slug: "connections", index: 10, label: "Connections", title: "What can SEO OS connect to?" },
  { slug: "review", index: 11, label: "Review", title: "Review your SEO operating context" },
] as const;

export type OnboardingStepSlug = (typeof ONBOARDING_STEPS)[number]["slug"];
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const FIRST_STEP: OnboardingStepSlug = "website";
export const REVIEW_STEP: OnboardingStepSlug = "review";

export function isStepSlug(value: string): value is OnboardingStepSlug {
  return ONBOARDING_STEPS.some((step) => step.slug === value);
}

export function getStep(slug: OnboardingStepSlug): OnboardingStep {
  const step = ONBOARDING_STEPS.find((candidate) => candidate.slug === slug);
  if (!step) {
    throw new Error(`Unknown onboarding step: ${slug}`);
  }
  return step;
}

export function stepIndex(slug: OnboardingStepSlug): number {
  return getStep(slug).index;
}

export function nextStep(slug: OnboardingStepSlug): OnboardingStepSlug | null {
  const step = ONBOARDING_STEPS.find((candidate) => candidate.index === stepIndex(slug) + 1);
  return step?.slug ?? null;
}

export function previousStep(slug: OnboardingStepSlug): OnboardingStepSlug | null {
  const step = ONBOARDING_STEPS.find((candidate) => candidate.index === stepIndex(slug) - 1);
  return step?.slug ?? null;
}

/**
 * A step may be opened if it has been reached before, or is the immediate next one.
 * Jumping further ahead is rejected server-side and redirected back to current.
 */
export function canOpenStep(
  requested: OnboardingStepSlug,
  current: OnboardingStepSlug,
): boolean {
  return stepIndex(requested) <= stepIndex(current);
}
