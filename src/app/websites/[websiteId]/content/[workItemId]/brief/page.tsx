import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { requireWebsiteAccess, websiteScope } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { getContentWorkItem } from "@/server/services/content-work";
import {
  BRIEF_FIELD_LABELS,
  changedFields,
  currentBrief,
  getBriefEvidence,
  listBriefVersions,
  type BriefVersion,
  type CitedClaim,
  type LinkTarget,
  type ProhibitedClaim,
  type RuleConstraint,
} from "@/server/services/content-brief";
import { getDraftForWorkItem } from "@/server/services/content-draft";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { StartDraftButton, StartFromBriefButton } from "@/components/execution/draft-controls";
import { DemoBadge, SeverityBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import {
  ApproveBriefButton,
  ArchiveBriefButton,
  GenerateBriefButton,
  RequestBriefReviewButton,
} from "@/components/execution/brief-controls";
import type { BriefSection } from "@/lib/ai/schemas/content-brief";

export const metadata = { title: "Brief · SEO OS" };

const BRIEFABLE = new Set(["QUEUED", "BRIEFING", "DRAFTING"]);

/**
 * The brief for one work item (docs/P4_SPEC.md §7, §8, §10-§12): the version
 * that stands or the one asked for, every field, what it rests on, who wrote
 * and approved it, and every earlier version with what changed between them.
 */
export default async function BriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { version: versionParam } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const versions = await listBriefVersions(context, item.id);
  const requested = versionParam ? Number(versionParam) : null;
  const selected =
    requested && Number.isInteger(requested)
      ? (versions.find((row) => row.version === requested) ?? null)
      : await currentBrief(context, item.id);

  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const canReview = hasRole(context.membership.role, REQUIRED.REVIEW);
  const briefable = BRIEFABLE.has(item.status);

  const [evidenceView, secondaryKeywords] = await Promise.all([
    selected ? getBriefEvidence(context, selected.id) : Promise.resolve(null),
    selected && Array.isArray(selected.secondaryKeywordIdsJson)
      ? prisma.keyword.findMany({
          where: {
            id: { in: selected.secondaryKeywordIdsJson as string[] },
            ...websiteScope(context),
          },
          select: { id: true, keyword: true },
        })
      : Promise.resolve([]),
  ]);

  const approvedStanding = versions.find((row) => row.status === "APPROVED") ?? null;
  const draftView = await getDraftForWorkItem(context, item.id);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={selected ? selected.title : "Brief"}
          description={`${humanize(item.type)} · ${item.title}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm">
        <Link href={`/websites/${websiteId}/content/${item.id}`} className="hover:underline">
          ← Work item
        </Link>
        <Link href={`/websites/${websiteId}/content`} className="hover:underline">
          Content Work Queue
        </Link>
      </nav>

      {!selected ? (
        <section className="space-y-4">
          <EmptyState>
            No brief yet. Generate one from the evidence, or write it by hand.
          </EmptyState>
          {canWrite && briefable ? (
            <div className="flex flex-wrap items-start gap-6">
              <GenerateBriefButton websiteId={websiteId} workItemId={item.id} />
              <Link
                href={`/websites/${websiteId}/content/${item.id}/brief/edit`}
                className="text-sm hover:underline"
              >
                Write it by hand
              </Link>
            </div>
          ) : null}
        </section>
      ) : (
        <>
          {/* --------------------------------------------------- Status */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">v{selected.version}</span>
              <StatusBadge status={selected.status} />
              {approvedStanding && approvedStanding.id !== selected.id ? (
                <span className="text-muted-foreground text-xs">
                  · the approved version is{" "}
                  <Link
                    href={`/websites/${websiteId}/content/${item.id}/brief?version=${approvedStanding.version}`}
                    className="hover:underline"
                  >
                    v{approvedStanding.version}
                  </Link>
                </span>
              ) : null}
            </div>

            {selected.status === "AWAITING_REVIEW" ? (
              <p className="border-border rounded-lg border border-dashed p-3 text-sm">
                <span className="font-medium">Review pending.</span> An SEO lead, admin or owner
                needs to approve this version before drafting can begin.
              </p>
            ) : null}
            {selected.status === "DRAFT" ? (
              <p className="text-muted-foreground text-sm">
                A draft. Edit it, then request review; nothing downstream starts until a version is
                approved.
              </p>
            ) : null}

            <p className="text-muted-foreground text-xs">
              {selected.createdByAiRun
                ? `Generated by ${selected.createdByAiRun.provider} · ${selected.createdByAiRun.model} · prompt v${selected.createdByAiRun.promptTemplateVersion} · output schema v${selected.createdByAiRun.outputSchemaVersion}`
                : selected.createdBy
                  ? `Written by ${selected.createdBy.email}`
                  : "Provenance not recorded"}
              {" · "}
              {selected.createdAt.toLocaleString("en-GB")}
              {selected.approvedBy && selected.approvedAt
                ? ` · approved by ${selected.approvedBy.email} on ${selected.approvedAt.toLocaleString("en-GB")}`
                : ""}
            </p>

            <div className="flex flex-wrap items-start gap-4">
              {canWrite && selected.status === "DRAFT" ? (
                <RequestBriefReviewButton websiteId={websiteId} briefId={selected.id} />
              ) : null}
              {canReview &&
              (selected.status === "DRAFT" || selected.status === "AWAITING_REVIEW") ? (
                <ApproveBriefButton websiteId={websiteId} briefId={selected.id} />
              ) : null}
              {canWrite && briefable ? (
                <Link
                  href={`/websites/${websiteId}/content/${item.id}/brief/edit?from=${selected.id}`}
                  className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm"
                >
                  {selected.status === "DRAFT" || selected.status === "AWAITING_REVIEW"
                    ? "Edit"
                    : "Edit as a new version"}
                </Link>
              ) : null}
              {canReview &&
              (selected.status === "DRAFT" ||
                selected.status === "AWAITING_REVIEW" ||
                selected.status === "SUPERSEDED") ? (
                <ArchiveBriefButton websiteId={websiteId} briefId={selected.id} />
              ) : null}
            </div>
            {canWrite && briefable ? (
              <GenerateBriefButton
                websiteId={websiteId}
                workItemId={item.id}
                label="Generate a new version"
              />
            ) : null}
            {selected.status === "APPROVED" ? (
              draftView && draftView.draft.briefId === selected.id ? (
                <p className="text-sm">
                  <Link
                    href={`/websites/${websiteId}/content/${item.id}/draft?draft=${draftView.draft.id}`}
                    className="font-medium hover:underline"
                  >
                    Open Draft →
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}
                    A draft is pinned to this version ({draftView.revisionCount} revision
                    {draftView.revisionCount === 1 ? "" : "s"},{" "}
                    {humanize(draftView.draft.status).toLowerCase()}).
                  </span>
                </p>
              ) : draftView ? (
                <div className="border-border space-y-3 rounded-lg border border-dashed p-3 text-sm">
                  <p>
                    <span className="font-medium">
                      The draft is based on Brief v{draftView.brief.version}. This version (v
                      {selected.version}) is now the approved one.
                    </span>{" "}
                    <span className="text-muted-foreground">
                      The draft was not moved; its history stays where it is.
                    </span>{" "}
                    <Link
                      href={`/websites/${websiteId}/content/${item.id}/draft?draft=${draftView.draft.id}`}
                      className="hover:underline"
                    >
                      Open that draft →
                    </Link>
                  </p>
                  {canWrite && item.status === "DRAFTING" ? (
                    <StartFromBriefButton
                      websiteId={websiteId}
                      workItemId={item.id}
                      briefId={selected.id}
                      version={selected.version}
                    />
                  ) : null}
                </div>
              ) : canWrite && item.status === "DRAFTING" ? (
                <StartDraftButton websiteId={websiteId} workItemId={item.id} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  Drafting starts from this approved version; a member or above starts it.
                </p>
              )
            ) : null}
          </section>

          {/* --------------------------------------------------- Source */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Where it comes from</h2>
            <dl className="divide-border border-border divide-y rounded-lg border text-sm">
              <Row label="Recommendation">
                <Link
                  href={`/websites/${websiteId}/review/${item.recommendation.id}`}
                  className="hover:underline"
                >
                  {item.recommendation.title}
                </Link>
                <span className="text-muted-foreground">
                  {" "}
                  · {humanize(item.recommendation.type)}
                </span>
              </Row>
              <Row label="Decision">
                {humanize(item.decision.decision)} by {item.decision.decidedBy.email} on{" "}
                {item.decision.decidedAt.toLocaleDateString("en-GB")}
              </Row>
              <Row label="Business goal">
                {selected.businessGoal ? (
                  <Link href={`/websites/${websiteId}/goals`} className="hover:underline">
                    {selected.businessGoal.title}
                  </Link>
                ) : (
                  <Muted>Not tied to a goal</Muted>
                )}
              </Row>
              <Row label="Target page">
                {selected.targetPage ? (
                  <Link
                    href={`/websites/${websiteId}/pages/${selected.targetPage.id}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {selected.targetPage.path}
                  </Link>
                ) : (
                  <Muted>None — new content</Muted>
                )}
              </Row>
              <Row label="Primary keyword">
                {selected.primaryKeyword ? (
                  <Link
                    href={`/websites/${websiteId}/keywords/${selected.primaryKeyword.id}`}
                    className="hover:underline"
                  >
                    {selected.primaryKeyword.keyword}
                  </Link>
                ) : (
                  <Muted>None named</Muted>
                )}
              </Row>
              <Row label="Secondary keywords">
                {secondaryKeywords.length > 0 ? (
                  secondaryKeywords.map((keyword) => keyword.keyword).join(", ")
                ) : (
                  <Muted>None from the evidence</Muted>
                )}
              </Row>
              <Row label="Topic">
                {selected.topic ? (
                  <Link
                    href={`/websites/${websiteId}/topics/${selected.topic.id}`}
                    className="hover:underline"
                  >
                    {selected.topic.name}
                  </Link>
                ) : (
                  <Muted>—</Muted>
                )}
              </Row>
              <Row label="Content type">{humanize(selected.contentType)}</Row>
              <Row label="Search intent">
                {selected.searchIntent ? (
                  humanize(selected.searchIntent)
                ) : (
                  <Muted>Not stated</Muted>
                )}
              </Row>
              <Row label="Primary conversion">
                {selected.primaryConversion ?? <Muted>Not stated</Muted>}
              </Row>
            </dl>
          </section>

          {/* --------------------------------------------------- The brief */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">The brief</h2>
            <dl className="divide-border border-border divide-y rounded-lg border text-sm">
              <Row label="Audience">{selected.audience ?? <Muted>—</Muted>}</Row>
              <Row label="Customer problem">{selected.customerProblem ?? <Muted>—</Muted>}</Row>
              <Row label="Desired outcome">{selected.desiredOutcome ?? <Muted>—</Muted>}</Row>
              <Row label="Recommended angle">{selected.recommendedAngle ?? <Muted>—</Muted>}</Row>
              <Row label="Key questions">
                <Lines items={asStrings(selected.keyQuestionsJson)} />
              </Row>
              <Row label="Required sections">
                <Sections items={asSections(selected.requiredSectionsJson)} />
              </Row>
              <Row label="Optional sections">
                <Sections items={asSections(selected.optionalSectionsJson)} />
              </Row>
              <Row label="Brand voice">{selected.brandVoiceNotes ?? <Muted>—</Muted>}</Row>
              <Row label="External evidence needed">
                <Lines items={asStrings(selected.externalEvidenceRequirementsJson)} />
              </Row>
            </dl>
          </section>

          {/* --------------------------------------------------- Constraints */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">What the piece may and may not say</h2>
            <dl className="divide-border border-border divide-y rounded-lg border text-sm">
              <Row label="Approved claims">
                {asClaims(selected.approvedClaimsJson).length === 0 ? (
                  <Muted>None. Approve Brand Facts to allow business claims.</Muted>
                ) : (
                  <ul className="space-y-1">
                    {asClaims(selected.approvedClaimsJson).map((claim) => (
                      <li key={`${claim.evidenceId}-${claim.text}`}>
                        {claim.text} <EvidenceChip id={claim.evidenceId} />
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
              <Row label="Prohibited claims">
                {asProhibited(selected.prohibitedClaimsJson).length === 0 ? (
                  <Muted>None recorded in the approved Business Context.</Muted>
                ) : (
                  <ul className="space-y-1">
                    {asProhibited(selected.prohibitedClaimsJson).map((claim) => (
                      <li key={`${claim.source}-${claim.text}`}>
                        {claim.text}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({humanize(claim.source)})
                        </span>{" "}
                        {claim.evidenceId ? <EvidenceChip id={claim.evidenceId} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
              <Row label="SEO rules">
                {asRules(selected.seoRuleConstraintsJson).length === 0 ? (
                  <Muted>No active rules.</Muted>
                ) : (
                  <ul className="space-y-1.5">
                    {asRules(selected.seoRuleConstraintsJson).map((rule) => (
                      <li key={rule.ruleId} className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={rule.severity} />
                          <span>{rule.rule}</span>
                          <EvidenceChip id={rule.evidenceId} />
                        </div>
                        {rule.constraint ? (
                          <p className="text-muted-foreground text-xs">
                            For this piece: {rule.constraint}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
              <Row label="Internal links">
                {asLinks(selected.internalLinkTargetsJson).length === 0 ? (
                  <Muted>No targets from the evidence.</Muted>
                ) : (
                  <ul className="space-y-1">
                    {asLinks(selected.internalLinkTargetsJson).map((link) => (
                      <li key={`${link.pageId}-${link.anchorText}`}>
                        <Link
                          href={`/websites/${websiteId}/pages/${link.pageId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {link.path ?? link.pageId}
                        </Link>{" "}
                        — “{link.anchorText}”{" "}
                        <span className="text-muted-foreground text-xs">{link.reason}</span>{" "}
                        <EvidenceChip id={link.evidenceId} />
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
            </dl>
          </section>

          {/* --------------------------------------------------- Provenance */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Evidence and provenance</h2>
            {selected.evidencePackage ? (
              <dl className="divide-border border-border divide-y rounded-lg border text-sm">
                <Row label="Evidence package">
                  <span className="font-mono text-xs">{selected.evidencePackage.contentHash}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {selected.evidencePackage.evidenceCount} records ·{" "}
                    {selected.evidencePackage.sealedAt ? "sealed" : "not sealed"}
                  </span>
                </Row>
                <Row label="Retrieval policy">
                  {selected.evidencePackage.retrievalPolicy
                    ? `${selected.evidencePackage.retrievalPolicy.name} v${selected.evidencePackage.retrievalPolicy.version}`
                    : `v${selected.evidencePackage.retrievalPolicyVersion ?? "?"}`}
                </Row>
                <Row label="Business Context version">
                  {selected.evidencePackage.contextVersionId ? (
                    <span className="font-mono text-xs">
                      {selected.evidencePackage.contextVersionId}
                    </span>
                  ) : (
                    <Muted>None approved when assembled</Muted>
                  )}
                </Row>
                <Row label="Assembled">
                  {selected.evidencePackage.assembledAt.toLocaleString("en-GB")}
                </Row>
                {selected.createdByAiRun ? (
                  <Row label="AI run">
                    <span className="font-mono text-xs">{selected.createdByAiRun.id}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {selected.createdByAiRun.provider} · {selected.createdByAiRun.model} ·
                      prompt v{selected.createdByAiRun.promptTemplateVersion} · schema v
                      {selected.createdByAiRun.outputSchemaVersion}
                    </span>
                  </Row>
                ) : (
                  <Row label="AI run">
                    <Muted>Written by hand from an earlier version&rsquo;s evidence</Muted>
                  </Row>
                )}
              </dl>
            ) : (
              <p className="text-muted-foreground text-sm">
                Written by hand with no evidence package. Generate a version to attach one.
              </p>
            )}

            {evidenceView && evidenceView.evidence.length > 0 ? (
              <details className="text-sm">
                <summary className="text-muted-foreground cursor-pointer">
                  {evidenceView.evidence.length} evidence records the model was shown
                  {evidenceView.stale.length > 0
                    ? ` · ${evidenceView.stale.length} no longer resolve`
                    : ""}
                </summary>
                <ul className="divide-border border-border mt-2 divide-y rounded-lg border">
                  {evidenceView.evidence.map((record) => (
                    <li key={record.id} className="space-y-0.5 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono">{record.id}</span>
                        <span className="text-muted-foreground">
                          {humanize(record.type)} · {record.source} · {humanize(record.reliability)}
                        </span>
                      </div>
                      {record.textValue ? (
                        <p className="text-muted-foreground line-clamp-2 text-xs">
                          {record.textValue}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {evidenceView.manifest?.notes.length ? (
                  <ul className="text-muted-foreground mt-2 list-disc pl-5 text-xs">
                    {evidenceView.manifest.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ) : null}
          </section>

          {/* --------------------------------------------------- History */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Versions</h2>
            <ul className="divide-border border-border divide-y rounded-lg border text-sm">
              {versions.map((row, index) => {
                const previous = versions[index + 1] ?? null;
                const changed = previous ? changedFields(previous, row) : [];
                return (
                  <li
                    key={row.id}
                    className={`space-y-1 px-4 py-3 ${row.id === selected.id ? "bg-muted/30" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/websites/${websiteId}/content/${item.id}/brief?version=${row.version}`}
                        className="font-mono text-xs hover:underline"
                      >
                        v{row.version}
                      </Link>
                      <StatusBadge status={row.status} />
                      <span className="text-muted-foreground text-xs">
                        {row.createdByAiRun
                          ? `generated · ${row.createdByAiRun.provider}`
                          : `written by ${row.createdBy?.email ?? "unknown"}`}
                        {" · "}
                        {row.createdAt.toLocaleString("en-GB")}
                        {row.approvedBy ? ` · approved by ${row.approvedBy.email}` : ""}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {previous
                        ? changed.length > 0
                          ? `Changed from v${previous.version}: ${changed
                              .map((key) => BRIEF_FIELD_LABELS[key] ?? key)
                              .join(", ")}`
                          : `Identical to v${previous.version}`
                        : "First version"}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-40 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function EvidenceChip({ id }: { id: string }) {
  return <span className="bg-muted/60 rounded px-1 font-mono text-[11px]">{id}</span>;
}

function Lines({ items }: { items: string[] }) {
  if (items.length === 0) return <Muted>—</Muted>;
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function Sections({ items }: { items: BriefSection[] }) {
  if (items.length === 0) return <Muted>—</Muted>;
  return (
    <ol className="list-decimal space-y-0.5 pl-5">
      {items.map((section) => (
        <li key={section.heading}>
          <span className="font-medium">{section.heading}</span>
          {section.purpose ? (
            <span className="text-muted-foreground"> — {section.purpose}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asSections(value: unknown): BriefSection[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is BriefSection => typeof v === "object" && v !== null && "heading" in v)
        .map((v) => ({ heading: String(v.heading), purpose: String(v.purpose ?? "") }))
    : [];
}

function asClaims(value: unknown): CitedClaim[] {
  return Array.isArray(value) ? (value as CitedClaim[]) : [];
}

function asProhibited(value: unknown): ProhibitedClaim[] {
  return Array.isArray(value) ? (value as ProhibitedClaim[]) : [];
}

function asRules(value: unknown): RuleConstraint[] {
  return Array.isArray(value) ? (value as RuleConstraint[]) : [];
}

function asLinks(value: unknown): LinkTarget[] {
  return Array.isArray(value) ? (value as LinkTarget[]) : [];
}

export type { BriefVersion };
