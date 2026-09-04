import { describe, expect, it } from "vitest";

import { REQUIRED, hasRole, roleRank } from "@/server/auth/roles";

describe("the role ladder", () => {
  it("is a strict order from VIEWER to OWNER", () => {
    expect(roleRank("VIEWER")).toBeLessThan(roleRank("MEMBER"));
    expect(roleRank("MEMBER")).toBeLessThan(roleRank("SEO_LEAD"));
    expect(roleRank("SEO_LEAD")).toBeLessThan(roleRank("ADMIN"));
    expect(roleRank("ADMIN")).toBeLessThan(roleRank("OWNER"));
  });

  it("puts the editor gate between writing and approving (P4, D2)", () => {
    expect(REQUIRED.REVIEW).toBe("SEO_LEAD");
    expect(roleRank(REQUIRED.WRITE)).toBeLessThan(roleRank(REQUIRED.REVIEW));
    expect(roleRank(REQUIRED.REVIEW)).toBeLessThan(roleRank(REQUIRED.APPROVE));
  });

  it("lets an SEO lead review but not approve, and a member write but not review", () => {
    expect(hasRole("SEO_LEAD", REQUIRED.REVIEW)).toBe(true);
    expect(hasRole("SEO_LEAD", REQUIRED.APPROVE)).toBe(false);
    expect(hasRole("MEMBER", REQUIRED.WRITE)).toBe(true);
    expect(hasRole("MEMBER", REQUIRED.REVIEW)).toBe(false);
    expect(hasRole("ADMIN", REQUIRED.REVIEW)).toBe(true);
    expect(hasRole("OWNER", REQUIRED.APPROVE)).toBe(true);
    expect(hasRole("VIEWER", REQUIRED.READ)).toBe(true);
  });
});
