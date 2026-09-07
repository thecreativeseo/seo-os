import type { CmsCapability, CmsEntityType, PageType } from "@/generated/prisma/client";

/**
 * What M6 is allowed to aim at, and what a connection must be known to permit
 * before it is aimed there (M6 plan D8, D14).
 *
 * WordPress core has two content kinds we can promise: a post and a page.
 * Custom post types exist on many installs and are configured per site, so
 * supporting them would mean guessing at names we cannot verify. M6 supports
 * the two, and a person chooses which.
 */

export const CMS_ENTITY_TYPES: readonly CmsEntityType[] = ["POST", "PAGE"];

export const CMS_ENTITY_TYPE_LABELS: Record<CmsEntityType, string> = {
  POST: "Post",
  PAGE: "Page",
};

export function isCmsEntityType(value: string): value is CmsEntityType {
  return (CMS_ENTITY_TYPES as readonly string[]).includes(value);
}

export function cmsEntityTypeLabel(value: CmsEntityType): string {
  return CMS_ENTITY_TYPE_LABELS[value];
}

/** Capabilities WordPress scopes by content kind. READ_CONTENT is not one of them. */
export const SCOPED_CAPABILITIES: readonly CmsCapability[] = [
  "CREATE_DRAFT",
  "UPDATE_DRAFT",
  "PUBLISH",
];

export function isScopedCapability(capability: CmsCapability): boolean {
  return SCOPED_CAPABILITIES.includes(capability);
}

/**
 * The entity type a capability row must carry. A scoped capability without one
 * would claim more than was asked, and an unscoped one with a type would claim
 * something narrower than what was answered.
 */
export function requiredEntityScope(capability: CmsCapability): "REQUIRED" | "NONE" {
  return isScopedCapability(capability) ? "REQUIRED" : "NONE";
}

export type EntityTypeSuggestion = {
  /** Never authoritative. A person confirms it before anything is created. */
  suggested: CmsEntityType | null;
  reason: string;
};

/**
 * A starting point for the person choosing, and nothing more.
 *
 * A page's SEO role is not its WordPress storage kind. An article is usually a
 * post and a service page is usually a page, but "usually" is not a fact about
 * this install, and a wrong guess creates the wrong kind of entity in someone
 * else's CMS. So this returns a suggestion with its reasoning attached, and the
 * service still requires an explicit choice.
 */
export function suggestEntityType(pageType: PageType | null): EntityTypeSuggestion {
  if (pageType === null) {
    return {
      suggested: null,
      reason: "No existing page is linked to this work, so there is nothing to infer from.",
    };
  }
  if (pageType === "UNKNOWN" || pageType === "OTHER") {
    return {
      suggested: null,
      reason: "The linked page has no settled classification, so there is nothing to infer from.",
    };
  }
  if (pageType === "BLOG_POST") {
    return {
      suggested: "POST",
      reason: "The linked page is classified as a blog post, which is usually a WordPress post.",
    };
  }
  return {
    suggested: "PAGE",
    reason: `The linked page is classified as ${pageType.toLowerCase().replace(/_/g, " ")}, which is usually a WordPress page.`,
  };
}
