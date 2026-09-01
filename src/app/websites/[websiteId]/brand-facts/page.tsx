import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listBrandFacts } from "@/server/services/governance";
import {
  approveBrandFactAction,
  archiveBrandFactAction,
  proposeBrandFactAction,
  rejectBrandFactAction,
} from "@/server/actions/governance";
import {
  ActionForm,
  Badge,
  EmptyState,
  Field,
  PageHeader,
} from "@/components/governance/primitives";

export const metadata = { title: "Brand Facts · SEO OS" };

export default async function BrandFactsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const facts = await listBrandFacts(context);
  const canWrite = hasRole(context.membership.role, "MEMBER");
  const canApprove = hasRole(context.membership.role, "ADMIN");

  const approved = facts.filter((fact) => fact.approvalStatus === "APPROVED");
  const proposed = facts.filter((fact) => fact.approvalStatus === "PROPOSED");
  const rejected = facts.filter((fact) => fact.approvalStatus === "REJECTED");

  return (
    <main className="space-y-10">
      <PageHeader
        title="Brand Facts"
        description="Verifiable statements about the business. Only approved facts are treated as canonical; a fact without a source stays unsourced rather than being given one."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          Awaiting review <span className="text-muted-foreground">({proposed.length})</span>
        </h2>
        {proposed.length === 0 ? (
          <EmptyState>Nothing awaiting review.</EmptyState>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {proposed.map((fact) => (
              <li key={fact.id} className="space-y-2 px-4 py-4">
                <FactBody fact={fact} />
                {canApprove ? (
                  <div className="flex gap-4">
                    <ActionForm
                      action={approveBrandFactAction}
                      websiteId={websiteId}
                      hidden={{ __factId: fact.id }}
                      submitLabel="Approve"
                      variant="quiet"
                      className=""
                    />
                    <ActionForm
                      action={rejectBrandFactAction}
                      websiteId={websiteId}
                      hidden={{ __factId: fact.id }}
                      submitLabel="Reject"
                      variant="quiet"
                      className=""
                    />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    An owner or admin decides on this fact.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          Canonical <span className="text-muted-foreground">({approved.length})</span>
        </h2>
        {approved.length === 0 ? (
          <EmptyState>
            No approved facts yet. Nothing downstream may treat an unapproved fact as
            true.
          </EmptyState>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {approved.map((fact) => (
              <li key={fact.id} className="space-y-2 px-4 py-4">
                <FactBody fact={fact} />
                {canWrite ? (
                  <ActionForm
                    action={archiveBrandFactAction}
                    websiteId={websiteId}
                    hidden={{ __factId: fact.id }}
                    submitLabel="Archive"
                    variant="quiet"
                    className=""
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {rejected.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">
            Rejected <span className="text-muted-foreground">({rejected.length})</span>
          </h2>
          <ul className="divide-border border-border divide-y rounded-lg border opacity-70">
            {rejected.map((fact) => (
              <li key={fact.id} className="px-4 py-4">
                <FactBody fact={fact} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canWrite ? (
        <section className="border-border space-y-4 rounded-lg border p-5">
          <h2 className="text-sm font-medium">Propose a fact</h2>
          <ActionForm
            action={proposeBrandFactAction}
            websiteId={websiteId}
            submitLabel="Propose fact"
            pendingLabel="Proposing…"
          >
            <Field name="category" label="Category" required placeholder="Company" />
            <Field name="factKey" label="Fact" required placeholder="Year founded" />
            <Field name="value" label="Value" required placeholder="2018" />
            <Field
              name="sourceUrl"
              label="Source URL"
              hint="Optional. Leave blank rather than guessing a source."
            />
          </ActionForm>
        </section>
      ) : null}
    </main>
  );
}

function FactBody({
  fact,
}: {
  fact: { category: string; factKey: string; value: string; sourceUrl: string | null; approvalStatus: string };
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          {fact.factKey}: {fact.value}
        </p>
        <p className="text-muted-foreground text-xs">
          {fact.category} ·{" "}
          {fact.sourceUrl ? (
            <span className="font-mono">{fact.sourceUrl}</span>
          ) : (
            <span className="italic">No source provided</span>
          )}
        </p>
      </div>
      <Badge>{fact.approvalStatus}</Badge>
    </div>
  );
}
