import { requireWorkspaceAccess } from "@/server/auth/guards";
import { listTeam } from "@/server/services/workspace";
import { Badge, PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Team · SEO OS" };

export default async function TeamPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await requireWorkspaceAccess(workspaceId);
  const members = await listTeam(context);

  return (
    <main className="space-y-8">
      <PageHeader
        title="Team"
        description="Who has access to this organization. Access comes from membership here — never from a matching email address or domain."
      />

      <ul className="divide-border border-border divide-y rounded-lg border">
        {members.map((member) => (
          <li
            key={member.membershipId}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {member.displayName ?? member.email}
                {member.isSelf ? (
                  <span className="text-muted-foreground font-normal"> · you</span>
                ) : null}
              </p>
              <p className="text-muted-foreground truncate text-sm">{member.email}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge>{member.role}</Badge>
              {member.status !== "ACTIVE" ? <Badge>{member.status}</Badge> : null}
            </div>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground border-border rounded-lg border border-dashed p-5 text-sm leading-relaxed">
        Inviting teammates is not built in this phase. The only ways to gain access are
        creating an organization and being invited by an owner or admin — and an
        invitation flow without tests behind it would be an untested way into a tenant.
      </p>
    </main>
  );
}
