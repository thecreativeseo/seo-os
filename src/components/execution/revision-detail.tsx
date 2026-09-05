import {
  previewHtml,
  revisionClaims,
  revisionFindings,
  type RevisionView,
} from "@/server/services/content-draft";
import { ClaimsPanel } from "@/components/execution/claims-panel";
import { FindingsPanel } from "@/components/execution/findings-panel";
import { ProvenancePanel, type ProvenanceLineage } from "@/components/execution/provenance-panel";

/**
 * One revision in full, read-only (docs/P4_SPEC.md §10, §12; M4.4): the
 * text with its sanitized preview, and beside it who wrote it and from
 * what, what the server found, and the claims it makes.
 */
export function RevisionDetail({
  revision,
  lineage,
  viewerUserId,
}: {
  revision: RevisionView;
  lineage: ProvenanceLineage;
  viewerUserId: string;
}) {
  const findings = revisionFindings(revision);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
      <section className="min-w-0 space-y-4" aria-labelledby="revision-text-heading">
        <h2 id="revision-text-heading" className="text-sm font-medium">
          Revision {revision.revisionNumber}
          <span className="text-muted-foreground font-normal">
            {" "}
            · {revision.wordCount ?? "?"} words
          </span>
        </h2>
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
          className="prose prose-sm border-border max-w-none overflow-x-auto rounded-lg border p-5 break-words"
          // Sanitized server-side by renderMarkdown: allowlisted tags only.
          dangerouslySetInnerHTML={{ __html: previewHtml(revision) }}
        />
      </section>

      <aside className="min-w-0 space-y-6">
        <ProvenancePanel revision={revision} lineage={lineage} viewerUserId={viewerUserId} />
        <FindingsPanel
          findings={findings?.findings ?? []}
          staleClaims={findings?.staleClaims ?? []}
        />
        <ClaimsPanel
          claims={revisionClaims(revision)}
          staleClaims={findings?.staleClaims ?? []}
          openQuestions={findings?.openQuestions ?? []}
        />
      </aside>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-36 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
