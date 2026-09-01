import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listGoals } from "@/server/services/governance";
import {
  activateGoalAction,
  createGoalAction,
  retireGoalAction,
} from "@/server/actions/governance";
import {
  ActionForm,
  Badge,
  EmptyState,
  Field,
  PageHeader,
} from "@/components/governance/primitives";

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
                <div className="flex gap-4">
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
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <section className="border-border space-y-4 rounded-lg border p-5">
          <h2 className="text-sm font-medium">Add a goal</h2>
          <ActionForm
            action={createGoalAction}
            websiteId={websiteId}
            submitLabel="Add goal"
            pendingLabel="Adding…"
          >
            <Field name="title" label="Goal" required placeholder="Generate qualified leads" />
            <Field name="businessObjective" label="Business objective" />
            <Field name="primaryMetric" label="Primary metric" placeholder="Demo requests" />
            <Field
              name="baseline"
              label="Baseline"
              hint="Leave blank if unknown. SEO OS will not assume a starting number."
            />
            <Field name="baselineSource" label="Baseline source" />
          </ActionForm>
        </section>
      ) : null}
    </main>
  );
}
