import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { ImportError, validateImport } from "@/server/services/import";
import { IMPORT_SOURCE_LABELS } from "@/lib/import/formats";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";
import { CommitImportControls } from "@/components/imports/import-controls";

export const metadata = { title: "Import preview · SEO OS" };

/**
 * The preview.
 *
 * Everything a person needs to answer one question — should this be written? — and
 * nothing that would answer it for them. Rejected rows are listed in full rather
 * than counted, because "12 rows were invalid" is not something anyone can act on.
 */
export default async function ImportPreviewPage({
  params,
}: {
  params: Promise<{ websiteId: string; importId: string }>;
}) {
  const { websiteId, importId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  let preview;

  try {
    preview = await validateImport(context, importId);
  } catch (error) {
    // An import belonging to another tenant is indistinguishable from one that
    // does not exist.
    if (error instanceof ImportError) notFound();
    throw error;
  }

  const { record, totals } = preview;
  const canWrite = hasRole(context.membership.role, "MEMBER");
  const committed = record.status === "COMMITTED";

  return (
    <main className="space-y-10">
      <div className="space-y-2">
        <Link
          href={`/websites/${websiteId}/imports`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Imports
        </Link>
        <PageHeader
          title={record.fileName}
          description={`${IMPORT_SOURCE_LABELS[record.source]} · uploaded ${record.createdAt.toLocaleString("en-GB")}`}
        />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium">What this file contains</h2>
          <Badge>{record.status}</Badge>
        </div>

        <dl className="border-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          {[
            { label: "Rows", value: totals.rows },
            { label: "Valid", value: totals.valid },
            { label: "Invalid", value: totals.invalid },
            { label: "Distinct keywords", value: totals.distinctKeywords },
          ].map((stat) => (
            <div key={stat.label} className="bg-background px-4 py-3">
              <dt className="text-muted-foreground text-xs">{stat.label}</dt>
              <dd className="mt-0.5 text-lg font-medium tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>

        {committed ? (
          <p className="text-muted-foreground text-sm">
            This import has been committed. Re-importing the same file will update the
            rows it produced rather than adding new ones.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            Nothing has been written yet. Committing writes the valid rows only.
          </p>
        )}
      </section>

      {preview.invalid.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Rows that will not be imported</h2>
          <p className="text-muted-foreground text-sm">
            These are listed in full rather than counted. A row is reported rather than
            repaired: guessing at a missing keyword or an unreadable position would put
            a number in SEO OS that nobody measured.
          </p>

          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {preview.invalid.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-4 py-2.5 tabular-nums">{row.rowNumber}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Sample of what will be written</h2>

        {preview.sample.length === 0 ? (
          <EmptyState>No valid rows in this file.</EmptyState>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">Keyword</th>
                  <th className="px-3 py-2 text-right font-medium">Position</th>
                  <th className="px-3 py-2 text-right font-medium">Volume</th>
                  <th className="px-3 py-2 font-medium">Ranking URL</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {preview.sample.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-4 py-2.5">{row.keyword}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {row.position ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {row.searchVolume?.toLocaleString("en-GB") ?? "—"}
                    </td>
                    <td className="text-muted-foreground max-w-md truncate px-3 py-2.5 font-mono text-xs">
                      {row.landingUrl ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totals.valid > preview.sample.length ? (
          <p className="text-muted-foreground text-xs">
            Showing {preview.sample.length} of {totals.valid} valid rows.
          </p>
        ) : null}
      </section>

      {canWrite && !committed ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Commit</h2>
          <CommitImportControls
            websiteId={websiteId}
            importId={record.id}
            canCommit={totals.valid > 0}
          />
        </section>
      ) : null}
    </main>
  );
}
