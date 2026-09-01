import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listSeoRules } from "@/server/services/governance";
import {
  createSeoRuleAction,
  editSeoRuleAction,
  toggleSeoRuleAction,
} from "@/server/actions/governance";
import {
  ActionForm,
  Badge,
  Choice,
  EmptyState,
  Field,
  PageHeader,
} from "@/components/governance/primitives";
import { EditDisclosure } from "@/components/governance/edit-disclosure";

export const metadata = { title: "SEO Rules · SEO OS" };

const SEVERITIES = [
  { value: "INFO", label: "Info" },
  { value: "WARNING", label: "Warning" },
  { value: "BLOCKING", label: "Blocking" },
] as const;

const CATEGORIES = [
  { value: "Content", label: "Content" },
  { value: "Technical", label: "Technical" },
  { value: "Brand", label: "Brand" },
  { value: "Legal", label: "Legal" },
  { value: "Publishing", label: "Publishing" },
] as const;

export default async function SeoRulesPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const rules = await listSeoRules(context);
  const canWrite = hasRole(context.membership.role, "MEMBER");

  return (
    <main className="space-y-10">
      <PageHeader
        title="SEO Rules"
        description="Constraints SEO work must respect on this website. These are rules your team states — SEO OS does not infer compliance requirements."
      />

      {rules.length === 0 ? (
        <EmptyState>No rules recorded yet.</EmptyState>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {rules.map((rule) => (
            <li key={rule.id} className="space-y-2 px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p className={`text-sm ${rule.active ? "" : "text-muted-foreground line-through"}`}>
                    {rule.rule}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {rule.category}
                    {rule.appliesTo ? ` · applies to ${rule.appliesTo}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge>{rule.severity}</Badge>
                  {!rule.active ? <Badge>INACTIVE</Badge> : null}
                </div>
              </div>
              {canWrite ? (
                <div className="space-y-3">
                  <ActionForm
                    action={toggleSeoRuleAction}
                    websiteId={websiteId}
                    hidden={{ __ruleId: rule.id, __active: rule.active ? "false" : "true" }}
                    submitLabel={rule.active ? "Deactivate" : "Reactivate"}
                    variant="quiet"
                    className=""
                  />

                  <EditDisclosure>
                    <ActionForm
                      action={editSeoRuleAction}
                      websiteId={websiteId}
                      hidden={{ __ruleId: rule.id }}
                      submitLabel="Save rule"
                      pendingLabel="Saving…"
                      variant="secondary"
                    >
                      <Choice
                        name="category"
                        label="Category"
                        options={CATEGORIES}
                        defaultValue={rule.category}
                      />
                      <Field
                        name="rule"
                        label="Rule"
                        required
                        multiline
                        defaultValue={rule.rule}
                      />
                      <Choice
                        name="severity"
                        label="Severity"
                        options={SEVERITIES}
                        defaultValue={rule.severity}
                      />
                      <Field
                        name="appliesTo"
                        label="Applies to"
                        defaultValue={rule.appliesTo ?? ""}
                      />
                    </ActionForm>
                  </EditDisclosure>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <section className="border-border space-y-4 rounded-lg border p-5">
          <h2 className="text-sm font-medium">Add a rule</h2>
          <ActionForm
            action={createSeoRuleAction}
            websiteId={websiteId}
            submitLabel="Add rule"
            pendingLabel="Adding…"
          >
            <Choice name="category" label="Category" options={CATEGORIES} defaultValue="Content" />
            <Field
              name="rule"
              label="Rule"
              required
              multiline
              placeholder="Never publish pricing figures without finance approval."
            />
            <Choice name="severity" label="Severity" options={SEVERITIES} defaultValue="INFO" />
            <Field name="appliesTo" label="Applies to" placeholder="Blog posts" />
          </ActionForm>
        </section>
      ) : null}
    </main>
  );
}
