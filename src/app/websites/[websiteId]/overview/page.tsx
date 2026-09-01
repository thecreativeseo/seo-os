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
import {
  TECHNICAL_HELP,
  VERIFICATION_HELP,
} from "@/components/governance/overview-help";
import { FieldHelp } from "@/components/ui/field-help";
import type { VerificationStatus } from "@/generated/prisma/client";

export const metadata = { title: "Overview · SEO OS" };

const STAGING = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

/**
 * Verification means domain ownership — proof the website is yours, not just a
 * domain someone typed in.
 *
 * Nothing in P0 verifies anything, so every website reads UNVERIFIED. Showing the
 * raw enum makes a working prototype look broken, so the value is phrased as the
 * roadmap item it is. It becomes real in P1: connecting Google Search Console
 * proves ownership, because GSC only returns data for properties already verified.
 */
const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  UNVERIFIED: "Not verified yet · P1",
  PENDING: "Verification in progress",
  VERIFIED: "Verified",
  FAILED: "Verification failed",
};

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
  ];

  const verificationLabel = VERIFICATION_LABELS[website.verificationStatus];
  const awaitingVerification = website.verificationStatus === "UNVERIFIED";

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
          <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground flex items-center gap-1.5">
              Verification
              <FieldHelp text={VERIFICATION_HELP} />
            </dt>
            <dd className={awaitingVerification ? "text-muted-foreground" : ""}>
              {verificationLabel}
            </dd>
          </div>
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
            <Field
              name="hostingNotes"
              label="Hosting"
              help={TECHNICAL_HELP.hostingNotes}
              defaultValue={technical?.hostingNotes ?? ""}
            />
            <Field
              name="knownMigrations"
              label="Known migrations"
              help={TECHNICAL_HELP.knownMigrations}
              multiline
              defaultValue={technical?.knownMigrations ?? ""}
            />
            <Field
              name="knownConstraints"
              label="Known constraints"
              help={TECHNICAL_HELP.knownConstraints}
              multiline
              defaultValue={technical?.knownConstraints ?? ""}
            />
            <Choice
              name="stagingAvailable"
              label="Staging environment"
              help={TECHNICAL_HELP.stagingAvailable}
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
              help={TECHNICAL_HELP.developerContact}
              defaultValue={technical?.developerContact ?? ""}
            />
            <Field
              name="publicationProcess"
              label="Publication process"
              help={TECHNICAL_HELP.publicationProcess}
              multiline
              defaultValue={technical?.publicationProcess ?? ""}
            />
            <Field
              name="technicalNotes"
              label="Notes"
              help={TECHNICAL_HELP.technicalNotes}
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
