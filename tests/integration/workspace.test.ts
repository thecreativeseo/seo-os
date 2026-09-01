import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import {
  WorkspaceError,
  countAuditEvents,
  listAuditEvents,
  listTeam,
  renameWorkspace,
} from "@/server/services/workspace";
import { createGoal } from "@/server/services/governance";
import type { TenantContext } from "@/server/auth/guards";
import type { Role } from "@/generated/prisma/client";

/**
 * Workspace section (P0_ACCEPTANCE_CRITERIA "Audit").
 *
 * "Secret in audit = P0 FAIL." These cover the read side: events are attributed,
 * scoped to their tenant, carry before/after where appropriate, and never contain
 * anything secret.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string, role: Role = "OWNER"): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `ws-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Workspace ${label}`, slug: `ws-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role,
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
    },
  });

  return { user, membership, organization, workspace, website };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("team", () => {
  it("lists organization members and marks the viewer", async () => {
    const context = await makeContext("team");
    const team = await listTeam(context);

    expect(team).toHaveLength(1);
    expect(team[0]?.email).toBe(context.user.email);
    expect(team[0]?.role).toBe("OWNER");
    expect(team[0]?.isSelf).toBe(true);
  });

  it("does not list another organization's members", async () => {
    const a = await makeContext("team-a");
    const b = await makeContext("team-b");

    const teamA = await listTeam(a);

    expect(teamA.map((member) => member.email)).not.toContain(b.user.email);
    expect(teamA).toHaveLength(1);
  });
});

describe("audit history", () => {
  it("records who changed what and when", async () => {
    const context = await makeContext("audit");
    const goal = await createGoal(context, { title: "Audited goal" });

    const events = await listAuditEvents(context);
    const entry = events.find((event) => event.entityId === goal.id);

    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe("BusinessGoal");
    expect(entry?.action).toBe("CREATE");
    expect(entry?.actor?.email).toBe(context.user.email);
    expect(entry?.createdAt).toBeInstanceOf(Date);
    expect(entry?.website?.normalizedDomain).toBe(context.website.normalizedDomain);
  });

  it("returns newest first", async () => {
    const context = await makeContext("order");
    await createGoal(context, { title: "First" });
    await createGoal(context, { title: "Second" });

    const events = await listAuditEvents(context);
    const timestamps = events.map((event) => event.createdAt.getTime());

    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it("captures before and after on an update", async () => {
    const context = await makeContext("beforeafter");
    const before = context.workspace.name;

    await renameWorkspace(context, "Renamed Team");

    const events = await listAuditEvents(context);
    const entry = events.find((event) => event.entityType === "Workspace");

    expect(entry?.beforeSnapshotJson).toMatchObject({ name: before });
    expect(entry?.afterSnapshotJson).toMatchObject({ name: "Renamed Team" });
  });

  it("counts events for the workspace", async () => {
    const context = await makeContext("count");
    expect(await countAuditEvents(context)).toBe(0);

    await createGoal(context, { title: "One" });
    await createGoal(context, { title: "Two" });

    expect(await countAuditEvents(context)).toBe(2);
  });

  it("never contains a secret", async () => {
    const context = await makeContext("secret");

    // A goal whose fields are deliberately named and valued like credentials.
    await createGoal(context, {
      title: "access_token rotation",
      businessObjective: "ya29.a0AfB_by-should-never-appear",
    });

    const events = await listAuditEvents(context);
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain("ya29.a0AfB_by-should-never-appear");
  });

  it("does not show another tenant's events", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");

    await createGoal(b, { title: "B's confidential goal" });

    const eventsA = await listAuditEvents(a);

    expect(eventsA).toHaveLength(0);
    expect(await countAuditEvents(a)).toBe(0);
    expect(await countAuditEvents(b)).toBe(1);
  });

  it("respects the take limit", async () => {
    const context = await makeContext("limit");
    await createGoal(context, { title: "One" });
    await createGoal(context, { title: "Two" });
    await createGoal(context, { title: "Three" });

    expect(await listAuditEvents(context, { take: 2 })).toHaveLength(2);
  });
});

describe("workspace settings", () => {
  it("renames a workspace", async () => {
    const context = await makeContext("rename");
    const updated = await renameWorkspace(context, "  SEO Team  ");

    expect(updated.name).toBe("SEO Team");
  });

  it("rejects a name that is too short", async () => {
    const context = await makeContext("short");
    await expect(renameWorkspace(context, "x")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("denies renaming to a MEMBER", async () => {
    const context = await makeContext("member", "MEMBER");

    await expect(renameWorkspace(context, "Hijacked")).rejects.toThrow(/permission/i);

    const unchanged = await prisma.workspace.findUnique({
      where: { id: context.workspace.id },
    });
    expect(unchanged?.name).toBe("Team");
  });

  it("allows an ADMIN to rename", async () => {
    const context = await makeContext("admin", "ADMIN");
    const updated = await renameWorkspace(context, "Admin Renamed");

    expect(updated.name).toBe("Admin Renamed");
  });
});
