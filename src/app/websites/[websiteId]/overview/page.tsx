import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { getTechnicalContext } from "@/server/services/governance";
import { saveTechnicalContextAction } from "@/server/actions/governance";
import {
  ActionForm,
  Choice,
  Field,
  PageHeader,
} from "@/components/governance/primitives";

export const metadata = { title: "Overview · SEO OS" };

const STAGING = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const technical = await getTechnicalContext(context);
  const canWrite = hasRole(context.membership.role, "MEMBER");
  const website = context.website;

  const facts: [string, string | null][] = [
    ["Domain", website.normalizedDomain],
    ["Name", website.name],
    ["Type", website.websiteType],
    ["CMS", website.cmsType],
    ["Primary market", website.primaryMarket],
    ["Primary language", website.primaryLanguage],
    ["Timezone", website.timezone],
    ["Verification", website.verificationStatus],
  ];

  return (
    <main className="space-y-10">
      <PageHeader
        title="Overview"
        description="What SEO OS knows about this website. Everything here was entered by your team; nothing is inferred."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Website</h2>
        <dl className="divide-border border-border divide-y rounded-lg border">
          {facts.map(([label, value]) => (
            <div key={label} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={value ? "" : "text-muted-foreground/70 italic"}>
                {value ?? "Not provided"}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Technical context</h2>
        <p className="text-muted-foreground text-sm">
          Operational facts your team knows. SEO OS makes no claim about crawl,
          indexation, or technical health in this phase.
        </p>
        {canWrite ? (
          <ActionForm
            action={saveTechnicalContextAction}
            websiteId={websiteId}
            submitLabel="Save technical context"
            pendingLabel="Saving…"
            className="border-border space-y-4 rounded-lg border p-5"
          >
            <Field name="hostingNotes" label="Hosting" defaultValue={technical?.hostingNotes ?? ""} />
            <Field
              name="knownMigrations"
              label="Known migrations"
              multiline
              defaultValue={technical?.knownMigrations ?? ""}
            />
            <Field
              name="knownConstraints"
              label="Known constraints"
              multiline
              defaultValue={technical?.knownConstraints ?? ""}
            />
            <Choice
              name="stagingAvailable"
              label="Staging environment"
              options={STAGING}
              includeBlank="Not answered"
              defaultValue={
                technical?.stagingAvailable === null || technical?.stagingAvailable === undefined
                  ? ""
                  : technical.stagingAvailable
                    ? "yes"
                    : "no"
              }
            />
            <Field
              name="developerContact"
              label="Developer contact"
              defaultValue={technical?.developerContact ?? ""}
            />
            <Field
              name="publicationProcess"
              label="Publication process"
              multiline
              defaultValue={technical?.publicationProcess ?? ""}
            />
            <Field
              name="technicalNotes"
              label="Notes"
              multiline
              defaultValue={technical?.technicalNotes ?? ""}
            />
          </ActionForm>
        ) : (
          <dl className="divide-border border-border divide-y rounded-lg border">
            <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
              <dt className="text-muted-foreground">Staging environment</dt>
              <dd className={technical?.stagingAvailable === null ? "text-muted-foreground/70 italic" : ""}>
                {technical?.stagingAvailable === null || technical === null
                  ? "Not answered"
                  : technical.stagingAvailable
                    ? "Yes"
                    : "No"}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}
