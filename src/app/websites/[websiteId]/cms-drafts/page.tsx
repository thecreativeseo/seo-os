import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { getCmsConnectionReadiness, listCmsDrafts } from "@/server/services/cms-drafts";
import type { CmsDraftRow, CmsDraftVerification } from "@/server/services/cms-drafts";
import {
  CMS_DRAFT_STATE_LABELS,
  CMS_DRAFT_STATE_MESSAGES,
  TARGET_LABELS,
  externalStatusLabel,
  shortRevisionHash,
} from "@/lib/cms/draft-ux";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import {
  CreateDraftButton,
  ReconcileDraftButton,
  ReverifyDraftButton,
} from "@/components/execution/cms-draft-controls";

export const metadata = { title: "CMS Drafts · SEO OS" };

/**
 * Execution → CMS Drafts (M6.4 §12).
 *
 * The workspace for the one external side effect this product has: creating a
 * draft in somebody's WordPress. Everything on it is arranged around four
 * distinctions that are easy to blur and expensive to get wrong — a draft is
 * not a published page, created is not verified, approved is not executed, and
 * written by a model is not approved by a person.
 *
 * So each row says what state it is in, in words, and offers exactly one act.
 * There is no publish control here, and there is nothing that edits WordPress:
 * the only writes M6 can make are one draft per approved work item, and the
 * only reads are the ones that check it.
 */

const VERIFICATION_LABELS: Record<string, string> = {
  CMS_STATUS_DRAFT: "Draft status",
  TITLE_MATCH: "Title",
  CONTENT_PRESENT: "Content",
  EXCERPT_MATCH: "Excerpt",
  SLUG_MATCH: "Slug",
};

function VerificationList({ checks }: { checks: CmsDraftVerification[] }) {
  if (checks.length === 0) return null;

  return (
    <dl className="mt-2 space-y-1">
      {checks.map((check) => (
        <div key={check.type} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <dt className="text-muted-foreground min-w-24">
            {VERIFICATION_LABELS[check.type] ?? check.type}
          </dt>
          <dd className="flex items-baseline gap-2">
            {/* Never colour alone: the word is the signal. */}
            <span
              className={
                check.status === "PASS"
                  ? "text-foreground font-medium"
                  : check.required
                    ? "font-medium text-red-600"
                    : "text-amber-700 dark:text-amber-400"
              }
            >
              {check.status === "PASS" ? "Pass" : check.status === "FAIL" ? "Fail" : "Not checked"}
            </span>
            {!check.required ? <span className="text-muted-foreground">advisory</span> : null}
            {check.detail ? <span className="text-muted-foreground">{check.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Provenance({ row }: { row: CmsDraftRow }) {
  const facts: [string, string | null][] = [
    ["Approved for CMS by", row.approvedByName],
    ["Requested by", row.requestedByName],
    ["Executed by", row.executedByName],
    [
      "Approved revision",
      row.revisionNumber !== null
        ? `v${row.revisionNumber}${row.revisionHash ? ` · ${shortRevisionHash(row.revisionHash)}` : ""}`
        : null,
    ],
    ["Target", row.targetEntityType ? TARGET_LABELS[row.targetEntityType] : null],
    ["WordPress status", row.externalEntityId ? externalStatusLabel(row.externalStatus) : null],
    ["WordPress id", row.externalEntityId],
    ["Site", row.siteHost],
    ["Created", row.completedAt?.toLocaleString("en-GB") ?? null],
    ["Verified", row.verifiedAt?.toLocaleString("en-GB") ?? null],
  ];

  return (
    <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      {facts
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium break-all">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export default async function CmsDraftsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const [rows, readiness] = await Promise.all([
    listCmsDrafts(context),
    getCmsConnectionReadiness(context),
  ]);

  const canReview = hasRole(context.membership.role, REQUIRED.REVIEW);

  return (
    <main className="space-y-8">
      <PageHeader
        title="CMS Drafts"
        description="Work approved for the CMS, and what happened when it was sent to WordPress. SEO OS creates drafts for review — it does not publish."
      />

      <section aria-labelledby="cms-connection" className="space-y-2">
        <h2 id="cms-connection" className="text-sm font-medium">
          WordPress connection
        </h2>
        <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-sm">
          <Badge>{readiness.status.replace(/_/g, " ")}</Badge>
          {readiness.siteHost ? (
            <span className="font-medium">{readiness.siteHost}</span>
          ) : (
            <span className="text-muted-foreground">No site configured</span>
          )}
          <span className="text-muted-foreground text-xs">
            Publishing mode: {readiness.publishingMode === "DRAFT_ONLY" ? "DRAFT ONLY" : "—"}
          </span>
          <Link
            href={`/websites/${websiteId}/connections`}
            className="text-muted-foreground hover:text-foreground ml-auto text-xs hover:underline"
          >
            Manage connection
          </Link>
        </div>
        {readiness.reason ? (
          <p className="text-muted-foreground text-xs">{readiness.reason}</p>
        ) : null}
      </section>

      <section aria-labelledby="cms-rows" className="space-y-3">
        <h2 id="cms-rows" className="text-sm font-medium">
          Work at the CMS gate
        </h2>

        {rows.length === 0 ? (
          <EmptyState>
            Nothing has been approved for the CMS yet. Work reaches this screen once a person
            approves an exact revision at the QA gate.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li
                key={row.workItemId}
                className="border-border space-y-3 rounded-lg border px-4 py-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/websites/${websiteId}/content/${row.workItemId}/qa`}
                        className="font-medium hover:underline"
                      >
                        {row.title}
                      </Link>
                      {row.simulated ? (
                        <span
                          title="A simulated CMS. No WordPress site was contacted."
                          className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-900 uppercase dark:bg-amber-950 dark:text-amber-300"
                        >
                          Demo execution
                        </span>
                      ) : null}
                      {context.website.isDemo ? <DemoBadge /> : null}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {CMS_DRAFT_STATE_MESSAGES[row.state]}
                    </p>
                  </div>
                  <Badge>{CMS_DRAFT_STATE_LABELS[row.state]}</Badge>
                </div>

                <Provenance row={row} />

                <VerificationList checks={row.verifications} />

                {row.externalUrl ? (
                  <p className="text-xs">
                    <a
                      href={row.externalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:underline"
                    >
                      Open in WordPress
                    </a>
                    <span className="text-muted-foreground">
                      {" "}
                      — the draft&apos;s address. You may need to sign in to WordPress.
                    </span>
                  </p>
                ) : null}

                {row.externalEntityId ? (
                  <p className="text-muted-foreground text-xs">
                    SEO plugin metadata: not written in this version. M6 creates the core title,
                    slug, body and excerpt only — nothing is written to Yoast, Rank Math or any
                    other plugin&apos;s fields.
                  </p>
                ) : null}

                {row.nextAction === "CREATE" ? (
                  <CreateDraftButton
                    websiteId={websiteId}
                    workItemId={row.workItemId}
                    title={row.title}
                    siteHost={readiness.siteHost}
                    targets={readiness.selectableTargets}
                  />
                ) : null}
                {row.nextAction === "RECONCILE" ? (
                  <ReconcileDraftButton websiteId={websiteId} workItemId={row.workItemId} />
                ) : null}
                {row.nextAction === "REVERIFY" ? (
                  <ReverifyDraftButton websiteId={websiteId} workItemId={row.workItemId} />
                ) : null}
                {row.nextAction === "NONE" && row.blockedReason ? (
                  <p className="text-muted-foreground text-sm">{row.blockedReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="cms-scope" className="space-y-2">
        <h2 id="cms-scope" className="text-sm font-medium">
          What this can and cannot do
        </h2>
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
          <li>Creates one WordPress draft per approved work item, and never a second.</li>
          <li>Reads that draft back and compares it with the exact approved revision.</li>
          <li>
            Does not publish, schedule, or change a page that already exists. Publishing is not
            built.
          </li>
          <li>Does not write Yoast, Rank Math or other plugin SEO fields.</li>
          {!canReview ? (
            <li>
              You can view these executions, but you do not have permission to create or reconcile
              CMS drafts.
            </li>
          ) : null}
        </ul>
      </section>
    </main>
  );
}
