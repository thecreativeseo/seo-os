import {
  describeAuthor,
  previewHtml,
  revisionClaims,
  revisionFindings,
  type RevisionView,
} from "@/server/services/content-draft";
import { SeverityBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";

/**
 * One revision, in full (docs/P4_SPEC.md §10, §12): who or what wrote it and
 * from what, what the server found, the claims it makes and how each is
 * supported, and the text itself with a sanitized preview. Used by the draft
 * screen for the current revision and by the read-only revision screen for
 * any earlier one.
 */
export function RevisionDetail({
  revision,
  viewerUserId,
}: {
  revision: RevisionView;
  viewerUserId: string;
}) {
  const author = describeAuthor(revision, viewerUserId);
  const claims = revisionClaims(revision);
  const findings = revisionFindings(revision);

  return (
    <>
      {/* ------------------------------------------------ Provenance */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          Revision {revision.revisionNumber}
          <span className="text-muted-foreground font-normal"> · {author.label}</span>
        </h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <Row label="Written by">
            {revision.createdByAiRun
              ? `${revision.createdByAiRun.provider} · ${revision.createdByAiRun.model} · prompt v${revision.createdByAiRun.promptTemplateVersion} · output schema v${revision.createdByAiRun.outputSchemaVersion}`
              : revision.createdBy
                ? revision.createdBy.email
                : "Not recorded"}
            <span className="text-muted-foreground">
              {" "}
              · {revision.createdAt.toLocaleString("en-GB")}
            </span>
          </Row>
          <Row label="Change summary">{revision.changeSummary}</Row>
          <Row label="Based on">
            {revision.basedOnRevisionNumber
              ? `revision ${revision.basedOnRevisionNumber}`
              : "nothing - the first revision"}
          </Row>
          <Row label="Evidence package">
            {revision.evidencePackage ? (
              <>
                <span className="font-mono text-xs">{revision.evidencePackage.contentHash}</span>
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  {revision.evidencePackage.retrievalPolicy
                    ? `${revision.evidencePackage.retrievalPolicy.name} v${revision.evidencePackage.retrievalPolicy.version}`
                    : "policy not recorded"}{" "}
                  · {revision.evidencePackage.evidenceCount} records ·{" "}
                  {revision.evidencePackage.sealedAt ? "sealed" : "not sealed"}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                None - written by hand against the facts approved at the time
              </span>
            )}
          </Row>
          <Row label="Business Context version">
            {revision.evidencePackage?.contextVersionId ? (
              <span className="font-mono text-xs">{revision.evidencePackage.contextVersionId}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="AI run">
            {revision.createdByAiRun ? (
              <span className="font-mono text-xs">{revision.createdByAiRun.id}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Request token">
            <span className="font-mono text-xs">{revision.generationToken ?? "—"}</span>
          </Row>
          <Row label="Content hash">
            <span className="font-mono text-xs">{revision.contentHash}</span>
          </Row>
          <Row label="Length">{revision.wordCount ?? "?"} words</Row>
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
                    <span className="text-muted-foreground text-xs">in {finding.field}</span>
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
            This revision has blocking findings. It is kept for the record; a later revision must
            resolve them before the draft can go for review.
          </p>
        ) : null}
        {findings && findings.staleClaims.length > 0 ? (
          <div className="border-border rounded-lg border border-dashed p-3 text-sm">
            <p className="font-medium">
              Brief claims that were stale when this was written - not offered to the writer:
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
        <h2 className="text-sm font-medium">Claims the revision makes</h2>
        {claims.length === 0 ? (
          <p className="text-muted-foreground text-sm">No business claims are declared.</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border text-sm">
            {claims.map((claim, index) => (
              <li key={`${claim.text}-${index}`} className="space-y-0.5 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={claim.status} />
                  <span>{claim.text}</span>
                </div>
                {claim.evidenceId ? <p className="font-mono text-xs">{claim.evidenceId}</p> : null}
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
        <h2 className="text-sm font-medium">The text</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <Row label="Title">{revision.title}</Row>
          <Row label="Slug">
            {revision.slug ? <span className="font-mono text-xs">{revision.slug}</span> : "—"}
          </Row>
          <Row label="Meta title">{revision.metaTitle ?? "—"}</Row>
          <Row label="Meta description">{revision.metaDescription ?? "—"}</Row>
          <Row label="Excerpt">{revision.excerpt ?? "—"}</Row>
        </dl>
        <article
          className="prose prose-sm border-border max-w-none rounded-lg border p-5"
          // Sanitized server-side by renderMarkdown: allowlisted tags only.
          dangerouslySetInnerHTML={{ __html: previewHtml(revision) }}
        />
      </section>
    </>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-44 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
