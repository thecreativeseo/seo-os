import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { requireWebsiteAccess, websiteScope } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { OPEN_REQUEST_STATUSES, getDiagnosisRequest } from "@/server/services/diagnosis";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import { CancelRequestButton, RequestPoller } from "@/components/diagnosis/request-controls";

export const metadata = { title: "Diagnosis request · SEO OS" };

/** A request that has sat unclaimed this long is a worker that is not running. */
const UNCLAIMED_AFTER_MS = 2 * 60 * 1000;

function isUnclaimed(request: { status: string; createdAt: Date }): boolean {
  return (
    request.status === "REQUESTED" && Date.now() - request.createdAt.getTime() > UNCLAIMED_AFTER_MS
  );
}

const STEPS: Array<{ status: string; label: string }> = [
  { status: "REQUESTED", label: "Waiting for the worker" },
  { status: "ASSEMBLING_EVIDENCE", label: "Assembling evidence" },
  { status: "READY", label: "Evidence sealed" },
  { status: "RUNNING", label: "Model reasoning" },
  { status: "COMPLETED", label: "Diagnosis stored" },
];

/**
 * One diagnosis request while it is in flight (docs/P3_SPEC.md section 14).
 *
 * The screen for the minute between pressing Diagnose and having a diagnosis.
 * It shows the row and nothing invented: which step the request is at, when it
 * was asked for, and - if it failed - our own sentence about why. Once a
 * diagnosis exists it sends the reader there.
 */
export default async function DiagnosisRequestPage({
  params,
}: {
  params: Promise<{ websiteId: string; requestId: string }>;
}) {
  const { websiteId, requestId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const request = await getDiagnosisRequest(context, requestId);
  if (!request) notFound();

  if (request.status === "COMPLETED") {
    const diagnosis = await prisma.diagnosis.findFirst({
      where: { requestId: request.id, ...websiteScope(context) },
      select: { id: true },
    });
    if (diagnosis) redirect(`/websites/${websiteId}/diagnoses/${diagnosis.id}`);
  }

  const page =
    request.targetType === "PAGE"
      ? await prisma.page.findFirst({
          where: { id: request.targetId, ...websiteScope(context) },
          select: { id: true, path: true },
        })
      : null;

  const open = OPEN_REQUEST_STATUSES.includes(request.status);
  const unclaimed = isUnclaimed(request);
  const canCancel = open && hasRole(context.membership.role, REQUIRED.WRITE);
  const stepIndex = STEPS.findIndex((step) => step.status === request.status);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Diagnosis request"
          description={
            page
              ? `${page.path} — the request is being handled by the worker.`
              : "The request is being handled by the worker."
          }
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <section className="border-border space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={request.status} />
          {open ? <RequestPoller /> : null}
        </div>

        {open ? (
          <ol className="space-y-1 text-sm">
            {STEPS.map((step, index) => {
              const state = index < stepIndex ? "done" : index === stepIndex ? "now" : "next";
              return (
                <li
                  key={step.status}
                  className={
                    state === "now"
                      ? "font-medium"
                      : state === "done"
                        ? "text-muted-foreground line-through"
                        : "text-muted-foreground"
                  }
                >
                  {state === "done" ? "✓ " : state === "now" ? "→ " : "· "}
                  {step.label}
                </li>
              );
            })}
          </ol>
        ) : null}

        {unclaimed ? (
          <p className="border-border rounded-md border border-dashed p-3 text-sm">
            No worker has picked this up in the last two minutes. The worker service may not be
            running; the request will start as soon as one is. You can also cancel it and try again
            later.
          </p>
        ) : null}

        {request.status === "FAILED" ? (
          <p role="alert" className="text-sm text-red-600">
            {request.errorSummary ?? "The diagnosis could not be completed."}
            {request.errorCode ? (
              <span className="text-muted-foreground"> ({humanize(request.errorCode)})</span>
            ) : null}
          </p>
        ) : null}

        {request.status === "CANCELLED" ? (
          <p className="text-muted-foreground text-sm">This request was cancelled.</p>
        ) : null}

        {request.status === "COMPLETED" ? (
          <p className="text-muted-foreground text-sm">
            The request completed, but its diagnosis is no longer available.
          </p>
        ) : null}

        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <Row label="Requested" value={request.createdAt.toLocaleString("en-GB")} />
          <Row
            label="Started"
            value={request.startedAt ? request.startedAt.toLocaleString("en-GB") : "—"}
          />
          <Row
            label="Finished"
            value={request.completedAt ? request.completedAt.toLocaleString("en-GB") : "—"}
          />
        </dl>

        <div className="flex flex-wrap items-center gap-4">
          {canCancel ? <CancelRequestButton websiteId={websiteId} requestId={request.id} /> : null}
          {page ? (
            <Link
              href={`/websites/${websiteId}/pages/${page.id}`}
              className="text-sm hover:underline"
            >
              Back to the page
            </Link>
          ) : null}
          <Link href={`/websites/${websiteId}/diagnoses`} className="text-sm hover:underline">
            All diagnoses
          </Link>
        </div>
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-3 px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
