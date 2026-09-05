import crypto from "node:crypto";

import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { isAiConfigured } from "@/server/ai/registry";
import { getContentWorkItem } from "@/server/services/content-work";
import { currentBrief } from "@/server/services/content-brief";
import {
  NO_PROVIDER_MESSAGE,
  getDraftForWorkItem,
  previewHtml,
  revisionClaims,
  revisionFindings,
} from "@/server/services/content-draft";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge, SeverityBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import { GenerateRevisionButton, StartDraftButton } from "@/components/execution/draft-controls";

export const metadata = { title: "Draft · SEO OS" };

/**
 * The draft for a work item (docs/P4_SPEC.md §9-§11; M4.2). The minimum a
 * person needs to start drafting, ask for a revision, and inspect what came
 * back: the text, its provenance, the claims it makes and how each is
 * supported, and what the server found and removed. Editing, history and
 * review arrive with M4.3.
 */
export default async function DraftPage({
  params,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const [view, brief] = await Promise.all([
    getDraftForWorkItem(context, item.id),
    currentBrief(context, item.id),
  ]);

  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const briefApproved = brief?.status === "APPROVED";
  const drafting = item.status === "DRAFTING";
  const aiConfigured = isAiConfigured();
  // Minted per render: a retry of this page's form returns the same revision.
  const generationToken = crypto.randomUUID();

  const current = view?.current ?? null;
  const claims = current ? revisionClaims(current) : [];
  const findings = current ? revisionFindings(current) : null;

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={current ? current.title : "Draft"}
          description={`${humanize(item.type)} · ${item.title}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm">
        <Link href={`/websites/${websiteId}/content/${item.id}`} className="hover:underline">
          ← Work item
        </Link>
        <Link href={`/websites/${websiteId}/content/${item.id}/brief`} className="hover:underline">
          Brief
        </Link>
      </nav>

      {!view ? (
        <section className="space-y-4">
          {!briefApproved || !drafting ? (
            <EmptyState>
              Drafting starts once a brief version has been approved.{" "}
              {brief
                ? `The current brief (v${brief.version}) is ${humanize(brief.status).toLowerCase()}.`
                : "There is no brief yet."}
            </EmptyState>
          ) : (
            <>
              <p className="text-muted-foreground max-w-prose text-sm">
                The draft will be pinned to brief{" "}
                <span className="font-mono">v{brief.version}</span>. Approving a later brief version
                will not move it.
              </p>
              {canWrite ? <StartDraftButton websiteId={websiteId} workItemId={item.id} /> : null}
            </>
          )}
        </section>
      ) : (
        <>
          {/* ------------------------------------------------ Status */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={view.draft.status} />
              <span className="text-muted-foreground text-xs">
                pinned to brief{" "}
                <Link
                  href={`/websites/${websiteId}/content/${item.id}/brief?version=${view.brief.version}`}
                  className="font-mono hover:underline"
                >
                  v{view.brief.version}
                </Link>
                {" · "}
                {view.revisionCount} revision{view.revisionCount === 1 ? "" : "s"}
              </span>
            </div>

            {view.briefMismatch ? (
              <p className="border-border rounded-lg border border-dashed p-3 text-sm">
                <span className="font-medium">A newer brief version is approved</span> (v
                {view.briefMismatch.approvedVersion}). This draft stays on v{view.brief.version};
                starting a draft from the new version arrives with the next milestone.
              </p>
            ) : null}

            {canWrite && drafting ? (
              aiConfigured ? (
                <GenerateRevisionButton
                  websiteId={websiteId}
                  workItemId={item.id}
                  draftId={view.draft.id}
                  generationToken={generationToken}
                  label={current ? "Generate again from the brief" : "Generate first draft"}
                />
              ) : (
                <p className="border-border rounded-lg border border-dashed p-3 text-sm">
                  {NO_PROVIDER_MESSAGE}{" "}
                  <span className="text-muted-foreground">
                    Hand-written revisions arrive with the next milestone.
                  </span>
                </p>
              )
            ) : null}
          </section>

          {!current ? (
            <EmptyState>No revision yet.</EmptyState>
          ) : (
            <>
              {/* ------------------------------------------------ Provenance */}
              <section className="space-y-3">
                <h2 className="text-sm font-medium">Revision {current.revisionNumber}</h2>
                <dl className="divide-border border-border divide-y rounded-lg border text-sm">
                  <Row label="Written by">
                    {current.createdByAiRun
                      ? `${current.createdByAiRun.provider} · ${current.createdByAiRun.model} · prompt v${current.createdByAiRun.promptTemplateVersion} · output schema v${current.createdByAiRun.outputSchemaVersion}`
                      : current.createdBy
                        ? current.createdBy.email
                        : "Not recorded"}
                    <span className="text-muted-foreground">
                      {" "}
                      · {current.createdAt.toLocaleString("en-GB")}
                    </span>
                  </Row>
                  <Row label="Change summary">{current.changeSummary}</Row>
                  <Row label="Based on">
                    {current.basedOnRevisionNumber
                      ? `revision ${current.basedOnRevisionNumber}`
                      : "nothing - the first revision"}
                  </Row>
                  <Row label="Evidence package">
                    {current.evidencePackage ? (
                      <>
                        <span className="font-mono text-xs">
                          {current.evidencePackage.contentHash}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          ·{" "}
                          {current.evidencePackage.retrievalPolicy
                            ? `${current.evidencePackage.retrievalPolicy.name} v${current.evidencePackage.retrievalPolicy.version}`
                            : "policy not recorded"}{" "}
                          · {current.evidencePackage.evidenceCount} records ·{" "}
                          {current.evidencePackage.sealedAt ? "sealed" : "not sealed"}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </Row>
                  <Row label="Business Context version">
                    {current.evidencePackage?.contextVersionId ? (
                      <span className="font-mono text-xs">
                        {current.evidencePackage.contextVersionId}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None approved when assembled</span>
                    )}
                  </Row>
                  <Row label="AI run">
                    {current.createdByAiRun ? (
                      <span className="font-mono text-xs">{current.createdByAiRun.id}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Row>
                  <Row label="Request token">
                    <span className="font-mono text-xs">{current.generationToken ?? "—"}</span>
                  </Row>
                  <Row label="Content hash">
                    <span className="font-mono text-xs">{current.contentHash}</span>
                  </Row>
                  <Row label="Length">{current.wordCount ?? "?"} words</Row>
                </dl>
              </section>

              {/* ------------------------------------------------ Findings */}
              <section className="space-y-3">
                <h2 className="text-sm font-medium">What the server found</h2>
                {findings && findings.findings.length > 0 ? (
                  <ul className="divide-border border-border divide-y rounded-lg border text-sm">
                    {findings.findings.map((finding, index) => (
                      <li key={`${finding.kind}-${index}`} className="space-y-1 px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={finding.severity} />
                          <span className="font-medium">{humanize(finding.kind)}</span>
                          {finding.field ? (
                            <span className="text-muted-foreground text-xs">
                              in {finding.field}
                            </span>
                          ) : null}
                        </div>
                        <p>{finding.message}</p>
                        {finding.excerpt ? (
                          <p className="text-muted-foreground text-xs">“{finding.excerpt}”</p>
                        ) : null}
                        {finding.url ? <p className="font-mono text-xs">{finding.url}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">Nothing to report.</p>
                )}
                {findings?.blocking ? (
                  <p className="text-sm text-red-600">
                    This revision has blocking findings. It is kept for the record; a person must
                    resolve them before it can go for review.
                  </p>
                ) : null}
                {findings && findings.staleClaims.length > 0 ? (
                  <div className="border-border rounded-lg border border-dashed p-3 text-sm">
                    <p className="font-medium">
                      Brief claims that were stale at generation time - not offered to the writer:
                    </p>
                    <ul className="text-muted-foreground mt-1 list-disc pl-5 text-xs">
                      {findings.staleClaims.map((claim) => (
                        <li key={claim.evidenceId}>
                          “{claim.text}” — {claim.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              {/* ------------------------------------------------ Claims */}
              <section className="space-y-3">
                <h2 className="text-sm font-medium">Claims the draft makes</h2>
                {claims.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    The draft declares no business claims.
                  </p>
                ) : (
                  <ul className="divide-border border-border divide-y rounded-lg border text-sm">
                    {claims.map((claim, index) => (
                      <li key={`${claim.text}-${index}`} className="space-y-0.5 px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={claim.status} />
                          <span>{claim.text}</span>
                        </div>
                        {claim.evidenceId ? (
                          <p className="font-mono text-xs">{claim.evidenceId}</p>
                        ) : null}
                        {claim.reason ? (
                          <p className="text-muted-foreground text-xs">{claim.reason}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {findings && findings.openQuestions.length > 0 ? (
                  <div className="text-sm">
                    <p className="font-medium">Open questions the writer left:</p>
                    <ul className="text-muted-foreground list-disc pl-5 text-xs">
                      {findings.openQuestions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              {/* ------------------------------------------------ The text */}
              <section className="space-y-3">
                <h2 className="text-sm font-medium">The draft</h2>
                <dl className="divide-border border-border divide-y rounded-lg border text-sm">
                  <Row label="Title">{current.title}</Row>
                  <Row label="Slug">
                    {current.slug ? <span className="font-mono text-xs">{current.slug}</span> : "—"}
                  </Row>
                  <Row label="Meta title">{current.metaTitle ?? "—"}</Row>
                  <Row label="Meta description">{current.metaDescription ?? "—"}</Row>
                  <Row label="Excerpt">{current.excerpt ?? "—"}</Row>
                </dl>
                <article
                  className="prose prose-sm border-border max-w-none rounded-lg border p-5"
                  // Sanitized server-side by renderMarkdown: allowlisted tags only.
                  dangerouslySetInnerHTML={{ __html: previewHtml(current) }}
                />
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-44 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
