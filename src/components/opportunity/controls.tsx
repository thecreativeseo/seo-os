"use client";

import { useActionState } from "react";

import {
  assignOpportunityAction,
  assignOwnershipAction,
  detectOpportunitiesAction,
  setOpportunityStatusAction,
  updateKeywordAction,
  type P2ActionState,
} from "@/server/actions/opportunity";

const initial: P2ActionState = {};

export function DetectOpportunitiesButton({ websiteId }: { websiteId: string }) {
  const [state, action, pending] = useActionState(detectOpportunitiesAction, initial);

  return (
    <div className="space-y-1.5">
      <form action={action}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <button
          type="submit"
          disabled={pending}
          className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
        >
          {pending ? "Looking…" : "Find opportunities"}
        </button>
      </form>

      {state.message ? (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {state.message}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

const NEXT_STATUS: Record<string, { label: string; status: string }[]> = {
  IDENTIFIED: [
    { label: "Qualify", status: "QUALIFIED" },
    { label: "Decline", status: "DECLINED" },
  ],
  QUALIFIED: [
    { label: "Schedule", status: "SCHEDULED" },
    { label: "Decline", status: "DECLINED" },
  ],
  SCHEDULED: [
    { label: "Start", status: "IN_PROGRESS" },
    { label: "Decline", status: "DECLINED" },
  ],
  IN_PROGRESS: [
    { label: "Complete", status: "COMPLETED" },
    { label: "Decline", status: "DECLINED" },
  ],
  DECLINED: [{ label: "Reopen", status: "IDENTIFIED" }],
  COMPLETED: [{ label: "Archive", status: "ARCHIVED" }],
  ARCHIVED: [],
};

/**
 * Only the transitions the service will actually accept are offered.
 *
 * A button that produces an error is a button that should not have been there.
 */
export function StatusActions({
  websiteId,
  opportunityId,
  status,
}: {
  websiteId: string;
  opportunityId: string;
  status: string;
}) {
  const [state, action, pending] = useActionState(setOpportunityStatusAction, initial);
  const options = NEXT_STATUS[status] ?? [];

  if (options.length === 0) {
    return <p className="text-muted-foreground text-sm">No further steps.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {options.map((option) => (
          <form key={option.status} action={action}>
            <input type="hidden" name="__websiteId" value={websiteId} />
            <input type="hidden" name="__opportunityId" value={opportunityId} />
            <input type="hidden" name="status" value={option.status} />
            <button
              type="submit"
              disabled={pending}
              className="border-border hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs disabled:opacity-60"
            >
              {option.label}
            </button>
          </form>
        ))}
      </div>

      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

export function AssignOwnerForm({
  websiteId,
  opportunityId,
  members,
  currentOwnerId,
}: {
  websiteId: string;
  opportunityId: string;
  members: { id: string; label: string }[];
  currentOwnerId: string | null;
}) {
  const [state, action, pending] = useActionState(assignOpportunityAction, initial);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__opportunityId" value={opportunityId} />

      <div className="space-y-1">
        <label htmlFor="owner" className="block text-xs font-medium">
          Owner
        </label>
        <select
          id="owner"
          name="ownerUserId"
          defaultValue={currentOwnerId ?? ""}
          className="border-border h-8 rounded-md border px-2 text-sm"
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.label}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="border-border hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs disabled:opacity-60"
      >
        {pending ? "Saving…" : "Assign"}
      </button>

      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The human inputs to the score.
 *
 * Business relevance is the one criterion nothing can derive, and it carries the
 * joint heaviest weight. This form is where it comes from.
 */
export function KeywordJudgementForm({
  websiteId,
  keywordId,
  intent,
  businessRelevance,
  commercialValue,
  businessGoalId,
  goals,
}: {
  websiteId: string;
  keywordId: string;
  intent: string;
  businessRelevance: number | null;
  commercialValue: number | null;
  businessGoalId: string | null;
  goals: { id: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(updateKeywordAction, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__keywordId" value={keywordId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="intent" className="block text-sm font-medium">
            Intent
          </label>
          <select
            id="intent"
            name="intent"
            defaultValue={intent}
            className="border-border h-9 w-full rounded-md border px-2 text-sm"
          >
            {[
              "INFORMATIONAL",
              "COMMERCIAL",
              "TRANSACTIONAL",
              "NAVIGATIONAL",
              "LOCAL",
              "MIXED",
              "UNKNOWN",
            ].map((value) => (
              <option key={value} value={value}>
                {value.charAt(0) + value.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            Setting this marks it as your team&apos;s judgement, and imports stop
            overwriting it.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="goal" className="block text-sm font-medium">
            Business goal
          </label>
          <select
            id="goal"
            name="businessGoalId"
            defaultValue={businessGoalId ?? ""}
            className="border-border h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="">Not linked</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            Work serving a stated goal scores higher.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="relevance" className="block text-sm font-medium">
            Business relevance (0–5)
          </label>
          <input
            id="relevance"
            name="businessRelevance"
            type="number"
            min={0}
            max={5}
            defaultValue={businessRelevance ?? ""}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          />
          <p className="text-muted-foreground text-xs">
            Nothing can derive this. Left blank, the score treats it neutrally and
            says so.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="commercial" className="block text-sm font-medium">
            Commercial value (0–5)
          </label>
          <input
            id="commercial"
            name="commercialValue"
            type="number"
            min={0}
            max={5}
            defaultValue={commercialValue ?? ""}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>

        {state.message ? (
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {state.message}
          </p>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Nominating the page that should own a keyword. */
export function AssignOwnershipForm({
  websiteId,
  keywordId,
  pages,
  currentPageId,
}: {
  websiteId: string;
  keywordId: string;
  pages: { id: string; path: string }[];
  currentPageId: string | null;
}) {
  const [state, action, pending] = useActionState(assignOwnershipAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__keywordId" value={keywordId} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="owning-page" className="block text-xs font-medium">
            Intended owner
          </label>
          <select
            id="owning-page"
            name="pageId"
            defaultValue={currentPageId ?? ""}
            className="border-border h-8 max-w-md rounded-md border px-2 text-sm"
          >
            <option value="">Choose a page</option>
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.path}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="border-border hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs disabled:opacity-60"
        >
          {pending ? "Saving…" : "Nominate"}
        </button>
      </div>

      {state.message ? (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {state.message}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
