import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import {
  OnboardingError,
  answersOf,
  currentStepOf,
  draftOf,
  getOrCreateSession,
  loadSession,
  saveDraft,
  saveStep,
} from "@/server/services/onboarding";
import { canOpenStep } from "@/lib/onboarding/steps";
import type { WorkspaceContext } from "@/server/auth/guards";

/**
 * Onboarding engine (P0_ACCEPTANCE_CRITERIA "Onboarding").
 *
 * Progress must persist server-side, survive refresh, be resumable, follow the spec
 * order, stay tenant-safe, and leave unanswered questions unknown.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<WorkspaceContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `onb-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Onboarding ${label}`, slug: `onb-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  return { user, membership, organization, workspace };
}

let contextA: WorkspaceContext;
let contextB: WorkspaceContext;

beforeAll(async () => {
  contextA = await makeContext("a");
  contextB = await makeContext("b");
});

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("session lifecycle", () => {
  it("starts at the website step with no website attached", async () => {
    const context = await makeContext("start");
    const session = await getOrCreateSession(context);

    expect(currentStepOf(session)).toBe("website");
    expect(session.websiteId).toBeNull();
    expect(session.status).toBe("IN_PROGRESS");
  });

  it("resumes the same session rather than starting a new one", async () => {
    const context = await makeContext("resume");
    const first = await getOrCreateSession(context);
    const second = await getOrCreateSession(context);

    expect(second.id).toBe(first.id);

    const count = await prisma.onboardingSession.count({
      where: { workspaceId: context.workspace.id },
    });
    expect(count).toBe(1);
  });
});

describe("persistence and resume", () => {
  it("persists answers server-side and survives a reload", async () => {
    const context = await makeContext("persist");
    let session = await getOrCreateSession(context);

    ({ session } = await saveStep(context, session, "website", {
      domain: "https://www.Example.com/",
      name: "Example",
    }));

    // Re-read exactly as a fresh request would.
    const reloaded = await loadSession(context, session.id);
    expect(reloaded).not.toBeNull();
    expect(answersOf(reloaded!).website?.name).toBe("Example");
    expect(currentStepOf(reloaded!)).toBe("business");
  });

  it("normalizes the domain when creating the website", async () => {
    const context = await makeContext("normalize");
    let session = await getOrCreateSession(context);

    ({ session } = await saveStep(context, session, "website", {
      domain: "https://www.Example.com/",
    }));

    const website = await prisma.website.findUnique({ where: { id: session.websiteId! } });
    expect(website?.normalizedDomain).toBe("example.com");
    // The raw input is preserved separately.
    expect(website?.domain).toBe("https://www.Example.com/");
  });

  it("does not rewind progress when an earlier step is edited", async () => {
    const context = await makeContext("rewind");
    let session = await getOrCreateSession(context);

    ({ session } = await saveStep(context, session, "website", { domain: "a.example.com" }));
    ({ session } = await saveStep(context, session, "business", {
      productService: "We sell widgets",
    }));
    expect(currentStepOf(session)).toBe("customer");

    ({ session } = await saveStep(context, session, "website", { domain: "a.example.com" }));
    expect(currentStepOf(session)).toBe("customer");
  });

  it("updates the same website instead of creating a second one", async () => {
    const context = await makeContext("update");
    let session = await getOrCreateSession(context);

    ({ session } = await saveStep(context, session, "website", { domain: "first.example.com" }));
    const firstId = session.websiteId;

    ({ session } = await saveStep(context, session, "website", { domain: "second.example.com" }));

    expect(session.websiteId).toBe(firstId);
    const websites = await prisma.website.count({ where: { workspaceId: context.workspace.id } });
    expect(websites).toBe(1);
  });
});

describe("autosave drafts", () => {
  it("persists half-typed input without advancing the step", async () => {
    const context = await makeContext("draft");
    const session = await getOrCreateSession(context);

    await saveDraft(context, session, "website", { domain: "half-typed.exa", name: "Half" });

    const reloaded = await loadSession(context, session.id);
    expect(draftOf(reloaded!, "website")).toEqual({
      domain: "half-typed.exa",
      name: "Half",
    });
    // Not advanced, and nothing committed.
    expect(currentStepOf(reloaded!)).toBe("website");
    expect(reloaded!.websiteId).toBeNull();
    expect(answersOf(reloaded!).website).toBeUndefined();
  });

  it("does not create a record from invalid draft input", async () => {
    const context = await makeContext("draftbad");
    const session = await getOrCreateSession(context);

    await saveDraft(context, session, "website", { domain: "localhost" });

    const websites = await prisma.website.count({ where: { workspaceId: context.workspace.id } });
    expect(websites).toBe(0);
  });

  it("discards the draft once the step commits", async () => {
    const context = await makeContext("draftclear");
    let session = await getOrCreateSession(context);

    await saveDraft(context, session, "business", { productService: "partial" });
    session = (await loadSession(context, session.id))!;
    expect(draftOf(session, "business")).toEqual({ productService: "partial" });

    ({ session } = await saveStep(context, session, "website", { domain: "dc.example.com" }));
    ({ session } = await saveStep(context, session, "business", {
      productService: "Complete answer",
    }));

    expect(draftOf(session, "business")).toEqual({});
    expect(answersOf(session).business?.productService).toBe("Complete answer");
  });

  it("keeps drafts separate from committed answers", async () => {
    const context = await makeContext("draftsep");
    let session = await getOrCreateSession(context);

    ({ session } = await saveStep(context, session, "website", { domain: "sep.example.com" }));
    await saveDraft(context, session, "customer", { primaryCustomer: "typing…" });

    const reloaded = await loadSession(context, session.id);
    // The committed website answer is untouched by the customer draft.
    expect(answersOf(reloaded!).website?.domain).toBe("sep.example.com");
    expect(answersOf(reloaded!)).not.toHaveProperty("__drafts");
  });

  it("does not leak drafts across tenants", async () => {
    const sessionA = await getOrCreateSession(contextA);
    await saveDraft(contextA, sessionA, "business", { productService: "A confidential" });

    const stolen = await loadSession(contextB, sessionA.id);
    expect(stolen).toBeNull();
  });
});

describe("repeatable list answers", () => {
  it("stores multiple buyer roles", async () => {
    const context = await makeContext("roles");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "roles.example.com" }));

    ({ session } = await saveStep(context, session, "customer", {
      primaryCustomer: "B2B marketing teams",
      buyerRoles: ["Head of Marketing", "SEO Manager", "CMO"],
    }));

    expect(answersOf(session).customer?.buyerRoles).toEqual([
      "Head of Marketing",
      "SEO Manager",
      "CMO",
    ]);
  });

  it("stores multiple additional markets and drops blanks", async () => {
    const context = await makeContext("markets");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "mk.example.com" }));

    ({ session } = await saveStep(context, session, "market", {
      primaryMarket: "Philippines",
      additionalMarkets: ["Singapore", "", "Malaysia"],
    }));

    expect(answersOf(session).market?.additionalMarkets).toEqual(["Singapore", "Malaysia"]);
  });

  it("leaves an empty list empty rather than inventing an entry", async () => {
    const context = await makeContext("emptylist");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "el.example.com" }));

    ({ session } = await saveStep(context, session, "customer", {
      primaryCustomer: "Someone",
      buyerRoles: [],
    }));

    expect(answersOf(session).customer?.buyerRoles).toEqual([]);
  });
});

describe("validation", () => {
  it("rejects an invalid domain", async () => {
    const context = await makeContext("baddomain");
    const session = await getOrCreateSession(context);

    await expect(
      saveStep(context, session, "website", { domain: "localhost" }),
    ).rejects.toBeInstanceOf(OnboardingError);
  });

  it("rejects a duplicate normalized domain in the same workspace", async () => {
    const context = await makeContext("dupe");
    const session = await getOrCreateSession(context);

    await prisma.website.create({
      data: {
        workspaceId: context.workspace.id,
        domain: "taken.example.com",
        normalizedDomain: "taken.example.com",
      },
    });

    await expect(
      saveStep(context, session, "website", { domain: "https://www.taken.example.com/" }),
    ).rejects.toThrow(/already set up/i);
  });

  it("requires the product/service answer", async () => {
    const context = await makeContext("required");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "req.example.com" }));

    await expect(
      saveStep(context, session, "business", { productService: "" }),
    ).rejects.toBeInstanceOf(OnboardingError);
  });

  it("leaves unanswered optional fields unknown rather than empty", async () => {
    const context = await makeContext("unknown");
    let session = await getOrCreateSession(context);

    ({ session } = await saveStep(context, session, "website", { domain: "unk.example.com" }));

    const website = await prisma.website.findUnique({ where: { id: session.websiteId! } });
    expect(website?.name).toBeNull();
    expect(website?.primaryMarket).toBeNull();
    expect(website?.timezone).toBeNull();
    expect(website?.websiteType).toBeNull();
  });
});

describe("step order", () => {
  it("matches the spec order", async () => {
    const context = await makeContext("order");
    let session = await getOrCreateSession(context);

    const expected = [
      "business",
      "customer",
      "conversion",
      "market",
      "competitors",
      "goals",
      "seo-priorities",
      "cms",
      "connections",
      "review",
    ];

    const inputs: Record<string, unknown> = {
      website: { domain: "order.example.com" },
      business: { productService: "Widgets" },
      customer: { primaryCustomer: "Operations leads" },
      conversion: { primaryConversion: "Request a demo" },
      market: { primaryMarket: "Philippines" },
      competitors: { competitors: [{ name: "Rival" }] },
      goals: { goals: [{ title: "Generate qualified leads" }] },
      "seo-priorities": { seoPriorities: ["Technical SEO"] },
      cms: { cms: "WORDPRESS" },
      connections: {},
    };

    const seen: string[] = [];
    for (const step of Object.keys(inputs)) {
      const result = await saveStep(context, session, step as never, inputs[step]);
      session = result.session;
      seen.push(currentStepOf(session));
    }

    expect(seen).toEqual(expected);
    expect(session.status).toBe("REVIEW");
  });

  it("refuses to open a step beyond current progress", () => {
    expect(canOpenStep("review", "website")).toBe(false);
    expect(canOpenStep("business", "website")).toBe(false);
    expect(canOpenStep("website", "customer")).toBe(true);
    expect(canOpenStep("customer", "customer")).toBe(true);
  });
});

describe("entity commits", () => {
  it("records competitors as user-provided and unclassified", async () => {
    const context = await makeContext("comp");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "comp.example.com" }));

    ({ session } = await saveStep(context, session, "competitors", {
      competitors: [
        { name: "Rival One", domain: "https://www.RivalOne.com/" },
        { name: "Rival Two" },
      ],
    }));

    const competitors = await prisma.competitor.findMany({
      where: { websiteId: session.websiteId! },
      orderBy: { name: "asc" },
    });

    expect(competitors).toHaveLength(2);
    expect(competitors[0]?.type).toBe("UNKNOWN");
    expect(competitors[0]?.source).toBe("USER_PROVIDED");
    expect(competitors[0]?.providedByUser).toBe(true);
    expect(competitors[0]?.normalizedDomain).toBe("rivalone.com");
    expect(competitors[1]?.normalizedDomain).toBeNull();
  });

  it("creates draft goals with a null baseline", async () => {
    const context = await makeContext("goal");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "goal.example.com" }));

    ({ session } = await saveStep(context, session, "goals", {
      goals: [{ title: "Generate qualified leads" }],
    }));

    const goals = await prisma.businessGoal.findMany({
      where: { websiteId: session.websiteId! },
    });

    expect(goals).toHaveLength(1);
    expect(goals[0]?.status).toBe("DRAFT");
    expect(goals[0]?.baseline).toBeNull();
    expect(goals[0]?.baselineSource).toBeNull();
  });

  it("writes the CMS to the website and technical context shell", async () => {
    const context = await makeContext("cms");
    let session = await getOrCreateSession(context);
    ({ session } = await saveStep(context, session, "website", { domain: "cms.example.com" }));

    ({ session } = await saveStep(context, session, "cms", { cms: "WORDPRESS" }));

    const website = await prisma.website.findUnique({ where: { id: session.websiteId! } });
    const technical = await prisma.technicalContext.findUnique({
      where: { websiteId: session.websiteId! },
    });

    expect(website?.cmsType).toBe("WORDPRESS");
    expect(technical?.cms).toBe("WORDPRESS");
    // Shell only: no inferred technical health.
    expect(technical?.technicalNotes).toBeNull();
    expect(technical?.knownConstraints).toBeNull();
  });
});

describe("tenant safety", () => {
  it("does not load another organization's session", async () => {
    const sessionA = await getOrCreateSession(contextA);

    const stolen = await loadSession(contextB, sessionA.id);

    expect(stolen).toBeNull();
  });

  it("scopes sessions to the workspace that created them", async () => {
    const sessionA = await getOrCreateSession(contextA);
    const sessionB = await getOrCreateSession(contextB);

    expect(sessionA.id).not.toBe(sessionB.id);
    expect(sessionA.organizationId).toBe(contextA.organization.id);
    expect(sessionB.organizationId).toBe(contextB.organization.id);
  });

  it("allows the same domain in two different workspaces", async () => {
    let a = await getOrCreateSession(contextA);
    let b = await getOrCreateSession(contextB);

    ({ session: a } = await saveStep(contextA, a, "website", { domain: "shared.example.com" }));
    ({ session: b } = await saveStep(contextB, b, "website", { domain: "shared.example.com" }));

    expect(a.websiteId).not.toBe(b.websiteId);
  });
});
