import { z } from "zod";

import { normalizeDomain } from "@/lib/domain/normalize-domain";
import type { OnboardingStepSlug } from "@/lib/onboarding/steps";
import { MAX_ADDITIONAL_MARKETS, resolveMarketCode } from "@/lib/markets";

/**
 * Per-step validation. Server-side, always (P0_SPEC.md §10).
 *
 * Optional fields become undefined rather than "" so an unanswered question stays
 * unknown in the database instead of being recorded as an empty answer.
 */

const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

const requiredText = (min = 2, max = 2000) =>
  z.string().trim().min(min, `Enter at least ${min} characters`).max(max);

/**
 * Repeatable single-value list. Blank rows are dropped rather than rejected: an
 * empty row in a "add another" list is an unanswered row, not a validation error.
 */
const stringList = z
  .array(z.string())
  .optional()
  .transform((value) => (value ?? []).map((entry) => entry.trim()).filter(Boolean));

/**
 * A market, stored as an ISO 3166-1 alpha-2 code.
 *
 * Accepts a code or a name the coercion layer recognises — "GB", "gb", "United
 * Kingdom" — and keeps the code. A draft saved before markets were a dropdown
 * still validates. A value nobody can resolve is refused rather than filed under
 * a default: this field decides which country's data the connectors ask for.
 */
const toMarketCode = (value: string, ctx: z.RefinementCtx): string => {
  const code = resolveMarketCode(value);
  if (code === null) {
    ctx.addIssue({ code: "custom", message: "Choose a market from the list" });
    return z.NEVER;
  }
  return code;
};

export const marketCode = z.string().trim().transform(toMarketCode);

/** Blank means unknown, so it stays undefined rather than failing. */
export const optionalMarketCode = z
  .string()
  .trim()
  .transform((value, ctx) => (value.length === 0 ? undefined : toMarketCode(value, ctx)))
  .optional();

/**
 * Up to MAX_ADDITIONAL_MARKETS distinct codes.
 *
 * Blanks are dropped and a repeated pick collapsed — those are slips, not
 * claims. An unrecognised entry and a sixth market are refused, because both
 * are things the form should have made impossible and the server must not
 * quietly repair.
 */
export const additionalMarketsList = z
  .array(z.string())
  .optional()
  .transform((values, ctx) => {
    const codes: string[] = [];
    for (const raw of values ?? []) {
      if (raw.trim().length === 0) continue;
      const code = resolveMarketCode(raw);
      if (code === null) {
        ctx.addIssue({ code: "custom", message: `"${raw}" is not a market SEO OS recognises` });
        return z.NEVER;
      }
      if (!codes.includes(code)) codes.push(code);
    }
    if (codes.length > MAX_ADDITIONAL_MARKETS) {
      ctx.addIssue({
        code: "custom",
        message: `Choose at most ${MAX_ADDITIONAL_MARKETS} additional markets`,
      });
      return z.NEVER;
    }
    return codes;
  });

/** The main market is the main market; listing it again says nothing. */
const noPrimaryInAdditional = (
  value: { primaryMarket?: string; additionalMarkets?: string[] },
  ctx: z.RefinementCtx,
): void => {
  if (value.primaryMarket && value.additionalMarkets?.includes(value.primaryMarket)) {
    ctx.addIssue({
      code: "custom",
      path: ["additionalMarkets"],
      message: "Additional markets cannot include the main market",
    });
  }
};

export const websiteStepSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1, "Enter a website domain")
      .superRefine((value, ctx) => {
        const result = normalizeDomain(value);
        if (!result.ok) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid domain, for example example.com",
          });
        }
      }),
    name: optionalText(200),
    websiteType: z
      .enum([
        "MARKETING_SITE",
        "ECOMMERCE",
        "SAAS_PRODUCT",
        "PUBLISHER",
        "MARKETPLACE",
        "LOCAL_BUSINESS",
        "OTHER",
        "UNKNOWN",
      ])
      .optional(),
    primaryLanguage: optionalText(50),
    primaryMarket: optionalMarketCode,
    additionalMarkets: additionalMarketsList,
    timezone: optionalText(80),
  })
  .superRefine(noPrimaryInAdditional);

export const businessStepSchema = z.object({
  productService: requiredText(),
  businessModel: optionalText(),
  companySummary: optionalText(),
});

export const customerStepSchema = z.object({
  primaryCustomer: requiredText(),
  buyerRoles: stringList,
});

export const conversionStepSchema = z.object({
  primaryConversion: requiredText(2, 200),
  secondaryConversions: stringList,
});

export const marketStepSchema = z
  .object({
    primaryMarket: marketCode,
    primaryLanguage: optionalText(50),
    additionalMarkets: additionalMarketsList,
  })
  .superRefine(noPrimaryInAdditional);

export const competitorsStepSchema = z.object({
  competitors: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Enter a name").max(200),
        domain: optionalText(253),
        notes: optionalText(500),
      }),
    )
    .max(20)
    .optional()
    .transform((value) => value ?? []),
});

export const goalsStepSchema = z.object({
  goals: z
    .array(
      z.object({
        title: z.string().trim().min(2, "Enter a goal").max(200),
        businessObjective: optionalText(500),
        primaryMetric: optionalText(120),
      }),
    )
    .max(10)
    .optional()
    .transform((value) => value ?? []),
});

export const seoPrioritiesStepSchema = z.object({
  seoPriorities: stringList,
});

export const cmsStepSchema = z.object({
  cms: z.enum([
    "WORDPRESS",
    "HUBSPOT_CMS",
    "WEBFLOW",
    "SHOPIFY",
    "DRUPAL",
    "CUSTOM",
    "OTHER",
    "UNKNOWN",
  ]),
  publicationProcess: optionalText(),
  developerContact: optionalText(200),
});

/** P0 shows connection architecture only; there is nothing to submit. */
export const connectionsStepSchema = z.object({});

export const reviewStepSchema = z.object({});

export const STEP_SCHEMAS = {
  website: websiteStepSchema,
  business: businessStepSchema,
  customer: customerStepSchema,
  conversion: conversionStepSchema,
  market: marketStepSchema,
  competitors: competitorsStepSchema,
  goals: goalsStepSchema,
  "seo-priorities": seoPrioritiesStepSchema,
  cms: cmsStepSchema,
  connections: connectionsStepSchema,
  review: reviewStepSchema,
} as const satisfies Record<OnboardingStepSlug, z.ZodType>;

export type StepAnswers = {
  [K in OnboardingStepSlug]?: z.infer<(typeof STEP_SCHEMAS)[K]>;
};

/** Options offered by the blueprint. Free text is allowed via "Other". */
export const CONVERSION_OPTIONS = [
  "Request a demo",
  "Book a meeting",
  "Start a trial",
  "Create an account",
  "Purchase",
  "Request a quote",
  "Submit a lead form",
  "Subscribe",
  "Other",
] as const;

export const GOAL_TEMPLATES = [
  "Generate qualified leads",
  "Generate demos",
  "Grow pipeline",
  "Increase trials",
  "Increase revenue",
  "Enter a new market",
  "Build category visibility",
  "Increase qualified organic traffic",
  "Improve AI visibility",
  "Reduce paid acquisition dependency",
  "Other",
] as const;

export const SEO_PRIORITY_OPTIONS = [
  "Technical SEO",
  "Content creation",
  "Content refresh",
  "Commercial rankings",
  "Keyword strategy",
  "Internal linking",
  "Competitor visibility",
  "Lead generation",
  "Local SEO",
  "AI visibility / GEO",
  "Digital PR / authority",
  "Reporting",
  "Not sure yet",
] as const;

export const CMS_OPTIONS = [
  { value: "WORDPRESS", label: "WordPress" },
  { value: "HUBSPOT_CMS", label: "HubSpot CMS" },
  { value: "WEBFLOW", label: "Webflow" },
  { value: "SHOPIFY", label: "Shopify" },
  { value: "DRUPAL", label: "Drupal" },
  { value: "CUSTOM", label: "Custom" },
  { value: "UNKNOWN", label: "Unknown" },
  { value: "OTHER", label: "Other" },
] as const;

export const WEBSITE_TYPE_OPTIONS = [
  { value: "MARKETING_SITE", label: "Marketing site" },
  { value: "ECOMMERCE", label: "Ecommerce" },
  { value: "SAAS_PRODUCT", label: "SaaS product" },
  { value: "PUBLISHER", label: "Publisher" },
  { value: "MARKETPLACE", label: "Marketplace" },
  { value: "LOCAL_BUSINESS", label: "Local business" },
  { value: "OTHER", label: "Other" },
  { value: "UNKNOWN", label: "Not sure yet" },
] as const;
