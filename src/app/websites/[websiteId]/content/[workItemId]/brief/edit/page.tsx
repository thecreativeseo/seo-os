import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { getContentWorkItem } from "@/server/services/content-work";
import { getBrief } from "@/server/services/content-brief";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { BriefEditForm, type BriefFormDefaults } from "@/components/execution/brief-form";
import type { BriefSection } from "@/lib/ai/schemas/content-brief";

export const metadata = { title: "Edit brief · SEO OS" };

const BRIEFABLE = new Set(["QUEUED", "BRIEFING", "DRAFTING"]);

/**
 * Writing or editing a brief version (docs/P4_SPEC.md §7). Starting from an
 * approved, superseded or archived version saves as the next version; a
 * draft or a version awaiting review is edited in place and returns to
 * draft. Starting from nothing writes version 1 by hand.
 */
export default async function BriefEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { from } = await searchParams;
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const source = from ? await getBrief(context, from) : null;
  if (from && (!source || source.contentWorkItemId !== item.id)) notFound();

  const briefable = BRIEFABLE.has(item.status) && hasRole(context.membership.role, REQUIRED.WRITE);
  const createsNewVersion =
    source !== null && source.status !== "DRAFT" && source.status !== "AWAITING_REVIEW";

  const defaults: BriefFormDefaults = {
    title: source?.title ?? item.title,
    contentType: source?.contentType ?? "",
    searchIntent: source?.searchIntent ?? "",
    primaryConversion: source?.primaryConversion ?? "",
    audience: source?.audience ?? "",
    customerProblem: source?.customerProblem ?? "",
    desiredOutcome: source?.desiredOutcome ?? item.objective,
    recommendedAngle: source?.recommendedAngle ?? "",
    keyQuestions: strings(source?.keyQuestionsJson).join("\n"),
    requiredSections: sections(source?.requiredSectionsJson),
    optionalSections: sections(source?.optionalSectionsJson),
    externalEvidenceRequirements: strings(source?.externalEvidenceRequirementsJson).join("\n"),
    brandVoiceNotes: source?.brandVoiceNotes ?? "",
  };

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={
            source
              ? createsNewVersion
                ? `New version from v${source.version}`
                : `Edit v${source.version}`
              : "Write the brief"
          }
          description={item.title}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm">
        <Link href={`/websites/${websiteId}/content/${item.id}/brief`} className="hover:underline">
          ← Brief
        </Link>
      </nav>

      {!briefable ? (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          This work item is {item.status.toLowerCase().replace(/_/g, " ")}; its brief can no longer
          be changed.
        </p>
      ) : (
        <>
          {source ? (
            <p className="text-muted-foreground max-w-prose text-sm">
              Approved claims, prohibited claims, SEO rules and link targets are carried from the
              version you started from; they come from the evidence, not from this form. Generate a
              new version to refresh them.
            </p>
          ) : (
            <p className="text-muted-foreground max-w-prose text-sm">
              A brief written by hand carries no evidence-backed claims or rules. Generate a version
              to attach the approved facts, prohibitions and rules from the evidence.
            </p>
          )}
          <BriefEditForm
            websiteId={websiteId}
            workItemId={item.id}
            briefId={source?.id ?? null}
            defaults={defaults}
            createsNewVersion={createsNewVersion}
          />
        </>
      )}
    </main>
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function sections(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((v): v is BriefSection => typeof v === "object" && v !== null && "heading" in v)
    .map((v) => (v.purpose ? `${v.heading} | ${v.purpose}` : v.heading))
    .join("\n");
}
