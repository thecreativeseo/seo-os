import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listImports } from "@/server/services/import";
import { IMPORT_SOURCE_LABELS } from "@/lib/import/semrush";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";
import { UploadImportForm } from "@/components/imports/import-controls";

export const metadata = { title: "Imports · SEO OS" };

export default async function ImportsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const imports = await listImports(context);

  const canWrite = hasRole(context.membership.role, "MEMBER");

  return (
    <main className="space-y-10">
      <PageHeader
        title="Imports"
        description="Keyword and ranking data from Semrush, read from an export. Every file is parsed and checked before anything is written."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">History</h2>

        {imports.length === 0 ? (
          <EmptyState>No file has been imported for this website yet.</EmptyState>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-3 py-2 font-medium">Format</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 text-right font-medium">Valid</th>
                  <th className="px-3 py-2 text-right font-medium">Invalid</th>
                  <th className="px-3 py-2 font-medium">Uploaded</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {imports.map((record) => (
                  <tr key={record.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/websites/${websiteId}/imports/${record.id}`}
                        className="underline underline-offset-4"
                      >
                        {record.fileName}
                      </Link>
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">
                      {IMPORT_SOURCE_LABELS[record.source]}
                    </td>
                    <td className="px-3 py-3">
                      <Badge>{record.status}</Badge>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{record.rowCount}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{record.validRowCount}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {record.invalidRowCount}
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">
                      {record.createdAt.toLocaleDateString("en-GB")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canWrite ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Import a file</h2>
          <div className="border-border rounded-lg border p-5">
            <UploadImportForm websiteId={websiteId} />
          </div>
          <p className="text-muted-foreground text-sm">
            Semrush data is third-party evidence. It is labelled as such wherever it
            appears, and is never merged with Search Console or Analytics figures.
          </p>
        </section>
      ) : null}
    </main>
  );
}
