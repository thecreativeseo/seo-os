import type { Role } from "@/generated/prisma/client";

/**
 * Role hierarchy (docs/P0_SPEC.md §7). Kept simple in P0: a total order, compared
 * by rank, with no per-resource permission matrix.
 */
const RANK: Record<Role, number> = {
  OWNER: 50,
  ADMIN: 40,
  SEO_LEAD: 30,
  MEMBER: 20,
  VIEWER: 10,
};

export function roleRank(role: Role): number {
  return RANK[role];
}

export function hasRole(actual: Role, minimum: Role): boolean {
  return roleRank(actual) >= roleRank(minimum);
}

/**
 * Minimum role required for each class of operation.
 *
 *   READ     everyone with any membership
 *   WRITE    create and edit governance records and drafts
 *   REVIEW   the editor gate (P4): approve briefs and content revisions,
 *            request publish approval — SEO_LEAD and above
 *   APPROVE  approve Business Context and Brand Facts, manage members and
 *            connections, authorize publishing — OWNER and ADMIN only
 */
export const REQUIRED = {
  READ: "VIEWER",
  WRITE: "MEMBER",
  REVIEW: "SEO_LEAD",
  APPROVE: "ADMIN",
} as const satisfies Record<string, Role>;
