import { requireWorkspaceAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { PageHeader } from "@/components/governance/primitives";
import { WorkspaceSettingsForm } from "@/components/shell/workspace-settings-form";

export const metadata = { title: "Settings · SEO OS" };

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await requireWorkspaceAccess(workspaceId);
  const canManage = hasRole(context.membership.role, "ADMIN");

  return (
    <main className="space-y-8">
      <PageHeader
        title="Settings"
        description="Details of this workspace and the organization that owns it."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Organization</h2>
        <dl className="divide-border border-border divide-y rounded-lg border">
          <Row label="Name" value={context.organization.name} />
          <Row label="Identifier" value={context.organization.slug} mono />
          <Row label="Your role" value={context.membership.role} mono />
        </dl>
        <p className="text-muted-foreground text-xs">
          Renaming an organization is not built in this phase.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Workspace</h2>
        {canManage ? (
          <WorkspaceSettingsForm
            workspaceId={workspaceId}
            defaultName={context.workspace.name}
          />
        ) : (
          <>
            <dl className="divide-border border-border divide-y rounded-lg border">
              <Row label="Name" value={context.workspace.name} />
            </dl>
            <p className="text-muted-foreground text-xs">
              An owner or admin can change workspace settings.
            </p>
          </>
        )}
      </section>
    </main>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}
