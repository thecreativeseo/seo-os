import { createHash } from "node:crypto";

import type { CmsEntityType, ExecutionType } from "@/generated/prisma/client";

/**
 * The identity of one CMS operation (M6 plan D3).
 *
 * A double-click, a refresh, a retried server action and a browser that gave up
 * and asked again are all the same intent. The only safe way to tell that is to
 * name the operation by what it is rather than by when it was asked for, so the
 * second request recognises the first instead of creating a second draft in
 * somebody's CMS.
 *
 * The key is derived here, on the server, from values the server already holds.
 * Nothing a browser sends contributes to it. That matters more than the
 * convenience of a client token: a caller who could choose the key could choose
 * to collide with someone else's operation, or to avoid colliding with their
 * own.
 *
 * Every component is part of the answer to "is this the same operation":
 *
 *   website      the tenant, so two tenants cannot share an identity
 *   connection   the CMS account, because the same words sent through a
 *                different connection is a different act
 *   site         the canonical destination, so repointing a connection at
 *                another WordPress is a different act even on the same row
 *   approval     the human authorization, which pins revision and hash
 *   hash         the words themselves, recomputed rather than trusted
 *   type         create a draft, update one, publish
 *   entity       a post and a page are different things to create
 *
 * The serialization is versioned and the version travels in the stored value,
 * so a key written today stays readable if the recipe ever changes: a new
 * recipe produces visibly different keys rather than silently different ones.
 */

export const IDEMPOTENCY_VERSION = "cms-exec/1";

/** Not a character any component can contain, so the join is unambiguous. */
const SEPARATOR = "\u001f";

export type ExecutionIdentity = {
  websiteId: string;
  connectionId: string;
  /** The canonical href from a validated base URL, never a raw typed string. */
  canonicalSite: string;
  contentCmsApprovalId: string;
  revisionHash: string;
  executionType: ExecutionType;
  targetEntityType: CmsEntityType;
};

/** The exact string that is hashed. Exported so a test can pin the recipe. */
export function canonicalIdentity(identity: ExecutionIdentity): string {
  const components = [
    IDEMPOTENCY_VERSION,
    identity.websiteId,
    identity.connectionId,
    identity.canonicalSite,
    identity.contentCmsApprovalId,
    identity.revisionHash,
    identity.executionType,
    identity.targetEntityType,
  ];

  for (const component of components) {
    if (component.length === 0 || component.includes(SEPARATOR)) {
      throw new Error("execution identity component is empty or contains the separator");
    }
  }

  return components.join(SEPARATOR);
}

export function executionIdempotencyKey(identity: ExecutionIdentity): string {
  const digest = createHash("sha256").update(canonicalIdentity(identity), "utf8").digest("hex");
  return `${IDEMPOTENCY_VERSION}:${digest}`;
}
