import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listGoals } from "@/server/services/governance";
import {
  activateGoalAction,
  createGoalAction,
  editGoalAction,
  retireGoalAction,
} from "@/server/actions/governance";
import {
  ActionForm,
  Badge,
  EmptyState,
  Field,
  PageHeader,
} from "@/components/governance/primitives";
import {
  GOAL_HELP,
  GOAL_PLACEHOLDERS,
  GOAL_TEMPLATES,
} from "@/components/governance/goal-help";
import { EditDisclosure } from "@/components/governance/edit-disclosure";

export const metadata = { title: "Business Goals · SEO OS" };

export default async function GoalsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const goals = await listGoals(context);
  const canWrite = hasRole(context.membership.role, "MEMBER");

  return (
    <main className="space-y-10">
      <PageHeader
        title="Business Goals"
        description="What SEO needs to help the business accomplish. Baselines stay empty until real data is connected."
      />

      {goals.length === 0 ? (
        <EmptyState>No goals yet.</EmptyState>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {goals.map((goal) => (
            <li key={goal.id} className="space-y-2 px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{goal.title}</p>
                  {goal.businessObjective ? (
                    <p className="text-muted-foreground text-sm">{goal.businessObjective}</p>
                  ) : null}
                  <p className="text-muted-foreground text-xs">
                    Metric: {goal.primaryMetric ?? "Not set"} · Baseline:{" "}
                    {goal.baseline === null ? (
                      <span className="italic">Unknown</span>
                    ) : (
                      String(goal.baseline)
                    )}
                  </p>
                </div>
                <Badge>{goal.status}</Badge>
              </div>

              {canWrite ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    {goal.status === "DRAFT" ? (
                      <ActionForm
                        action={activateGoalAction}
                        websiteId={websiteId}
                        hidden={{ __goalId: goal.id }}
                        submitLabel="Activate"
                        variant="quiet"
                        className=""
                      />
                    ) : null}
                    {goal.status !== "RETIRED" ? (
                      <ActionForm
                        action={retireGoalAction}
                        websiteId={websiteId}
                        hidden={{ __goalId: goal.id }}
                        submitLabel="Retire"
                        variant="quiet"
                        className=""
                      />
                    ) : null}
                  </div>

                  <EditDisclosure>
                    <ActionForm
                      action={editGoalAction}
                      websiteId={websiteId}
                      hidden={{ __goalId: goal.id }}
                      submitLabel="Save goal"
                      pendingLabel="Saving…"
                      variant="secondary"
                    >
                      <Field
                        name="title"
                        label="Goal"
                        required
                        help={GOAL_HELP.title}
                        defaultValue={goal.title}
                      />
                      <Field
                        name="businessObjective"
                        label="Business objective"
                        help={GOAL_HELP.businessObjective}
                        defaultValue={goal.businessObjective ?? ""}
                      />
                      <Field
                        name="primaryMetric"
                        label="Primary metric"
                        help={GOAL_HELP.primaryMetric}
                        defaultValue={goal.primaryMetric ?? ""}
                      />
                      <Field
                        name="baseline"
                        label="Baseline"
                        help={GOAL_HELP.baseline}
                        defaultValue={goal.baseline === null ? "" : String(goal.baseline)}
                        hint="Leave blank if unknown."
                      />
                      <Field
                        name="baselineSource"
                        label="Baseline source"
                        help={GOAL_HELP.baselineSource}
                        defaultValue={goal.baselineSource ?? ""}
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
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Add a goal</h2>
            <p className="text-muted-foreground text-sm">
              The greyed-out text in each field is one worked example, shown end to end
              so the parts line up. Nothing is filled in for you.
            </p>
          </div>

          <ActionForm
            action={createGoalAction}
            websiteId={websiteId}
            submitLabel="Add goal"
            pendingLabel="Adding…"
          >
            <Field
              name="title"
              label="Goal"
              required
              help={GOAL_HELP.title}
              placeholder={GOAL_PLACEHOLDERS.title}
              list="goal-templates"
              hint="Start typing for common goals, or write your own."
            />
            <Field
              name="businessObjective"
              label="Business objective"
              help={GOAL_HELP.businessObjective}
              placeholder={GOAL_PLACEHOLDERS.businessObjective}
            />
            <Field
              name="primaryMetric"
              label="Primary metric"
              help={GOAL_HELP.primaryMetric}
              placeholder={GOAL_PLACEHOLDERS.primaryMetric}
            />
            <Field
              name="baseline"
              label="Baseline"
              help={GOAL_HELP.baseline}
              placeholder={GOAL_PLACEHOLDERS.baseline}
              hint="Leave blank if unknown. SEO OS will not assume a starting number."
            />
            <Field
              name="baselineSource"
              label="Baseline source"
              help={GOAL_HELP.baselineSource}
              placeholder={GOAL_PLACEHOLDERS.baselineSource}
            />

            <datalist id="goal-templates">
              {GOAL_TEMPLATES.map((template) => (
                <option key={template} value={template} />
              ))}
            </datalist>
          </ActionForm>
        </section>
      ) : null}
    </main>
  );
}
