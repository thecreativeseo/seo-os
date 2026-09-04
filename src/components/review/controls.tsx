"use client";

import { useActionState, useState } from "react";

import { decideRecommendationAction, type ReviewActionState } from "@/server/actions/review";
import { LEVELS, PRIORITY_LEVELS, RECOMMENDATION_TYPES } from "@/lib/ai/schemas/page-diagnosis";
import { humanize } from "@/components/diagnosis/primitives";

const initial: ReviewActionState = {};

type Decision = "APPROVED" | "MODIFIED" | "REJECTED" | "NEEDS_EVIDENCE";

/**
 * The four decisions (docs/P3_SPEC.md §24), and nothing that executes.
 *
 * One panel, one action, one decision at a time. The form carries the decision
 * as data, but authority never does: the action re-checks the reviewer's role
 * and the service checks it again, so a form that names APPROVED from a viewer's
 * browser is refused twice over.
 *
 * A blocked recommendation cannot be approved silently (§23). The override
 * fields appear only then, and they name the rule.
 */
export function DecisionPanel({
  websiteId,
  recommendationId,
  status,
  blockedRule,
  canDecide,
}: {
  websiteId: string;
  recommendationId: string;
  status: string;
  blockedRule: { id: string; rule: string } | null;
  canDecide: boolean;
}) {
  const [state, action, pending] = useActionState(decideRecommendationAction, initial);
  const [choice, setChoice] = useState<Decision | null>(null);

  const decided = state.decided;
  const reviewable = status === "AWAITING_REVIEW" || status === "NEEDS_EVIDENCE";

  if (decided) {
    return (
      <p className="border-border rounded-lg border p-4 text-sm">
        Decision recorded: <span className="font-medium">{humanize(decided)}</span>. It is written
        to the audit trail with your name and the time.
      </p>
    );
  }

  if (!reviewable) {
    return (
      <p className="text-muted-foreground text-sm">
        This recommendation was already decided ({humanize(status).toLowerCase()}). Decisions are
        appended, never rewritten.
      </p>
    );
  }

  if (!canDecide) {
    return (
      <p className="text-muted-foreground text-sm">
        An owner or admin decides. You can read everything here; you cannot approve, modify, reject,
        or request evidence.
      </p>
    );
  }

  const options: { value: Decision; label: string; disabled?: boolean; why?: string }[] = [
    {
      value: "APPROVED",
      label: "Approve",
      disabled: status === "NEEDS_EVIDENCE",
      why: status === "NEEDS_EVIDENCE" ? "Needs evidence before it can be approved." : undefined,
    },
    { value: "MODIFIED", label: "Modify" },
    { value: "REJECTED", label: "Reject" },
    { value: "NEEDS_EVIDENCE", label: "Request more evidence" },
  ];

  const field =
    "border-border focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none";

  return (
    <div className="border-border space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled || pending}
            title={option.why}
            onClick={() => setChoice(option.value)}
            className={`inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-50 ${
              choice === option.value
                ? "bg-foreground text-background border-foreground"
                : "border-border hover:bg-accent"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {choice ? (
        <form action={action} className="space-y-3">
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__recommendationId" value={recommendationId} />
          <input type="hidden" name="decision" value={choice} />

          {choice === "APPROVED" && blockedRule ? (
            <div className="space-y-2 rounded-md border border-amber-700/40 p-3">
              <p className="text-sm">
                A BLOCKING SEO rule applies: <span className="font-medium">{blockedRule.rule}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                Approving overrides this rule, by name, under your name. Say why.
              </p>
              <input type="hidden" name="overrideRuleId" value={blockedRule.id} />
              <textarea
                name="overrideReason"
                rows={2}
                required
                placeholder="Why this rule does not apply here, or why it is worth setting aside"
                className={field}
              />
            </div>
          ) : null}

          {choice === "MODIFIED" ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                Fill in only what you are changing. The proposal stays as the model wrote it; your
                changes are recorded beside it.
              </p>
              <input name="mod_title" placeholder="New title" className={field} />
              <textarea name="mod_summary" rows={2} placeholder="New summary" className={field} />
              <textarea
                name="mod_rationale"
                rows={2}
                placeholder="New rationale"
                className={field}
              />
              <textarea
                name="mod_expectedEffectDescription"
                rows={2}
                placeholder="New expected effect, in words - no figures"
                className={field}
              />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Select name="mod_type" label="Type" options={RECOMMENDATION_TYPES} />
                <Select name="mod_priority" label="Priority" options={PRIORITY_LEVELS} />
                <Select name="mod_effort" label="Effort" options={LEVELS} />
                <Select name="mod_risk" label="Risk" options={LEVELS} />
              </div>
            </div>
          ) : null}

          <textarea
            name="reason"
            rows={2}
            required={choice === "REJECTED" || choice === "NEEDS_EVIDENCE"}
            placeholder={
              choice === "REJECTED"
                ? "Why this should not be done (required)"
                : choice === "NEEDS_EVIDENCE"
                  ? "What evidence would change the answer (required)"
                  : "Reason (optional)"
            }
            className={field}
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
            >
              {pending ? "Recording…" : `Confirm: ${humanize(choice)}`}
            </button>
            <span className="text-muted-foreground text-xs">
              No execution in this phase. Approval records intent; nothing changes on the site.
            </span>
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-red-600">
              {state.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function Select({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: readonly string[];
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        name={name}
        defaultValue=""
        className="border-border h-9 w-full rounded-md border px-2 text-sm"
      >
        <option value="">Keep as is</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {humanize(option)}
          </option>
        ))}
      </select>
    </label>
  );
}
