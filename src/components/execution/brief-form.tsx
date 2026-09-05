"use client";

import { useActionState } from "react";

import { saveBriefAction, type BriefActionState } from "@/server/actions/content-brief";
import { CONTENT_TYPES, SEARCH_INTENTS } from "@/lib/ai/schemas/content-brief";

const initial: BriefActionState = {};

export type BriefFormDefaults = {
  title: string;
  contentType: string;
  searchIntent: string;
  primaryConversion: string;
  audience: string;
  customerProblem: string;
  desiredOutcome: string;
  recommendedAngle: string;
  keyQuestions: string;
  requiredSections: string;
  optionalSections: string;
  externalEvidenceRequirements: string;
  brandVoiceNotes: string;
};

const INPUT =
  "border-border bg-background w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2";

function Text({
  name,
  label,
  defaultValue,
  hint,
  rows,
  required,
}: {
  name: string;
  label: string;
  defaultValue: string;
  hint?: string;
  rows?: number;
  required?: boolean;
}) {
  const id = `brief-${name}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {rows ? (
        <textarea
          id={id}
          name={name}
          rows={rows}
          defaultValue={defaultValue}
          required={required}
          className={INPUT}
        />
      ) : (
        <input
          id={id}
          name={name}
          type="text"
          defaultValue={defaultValue}
          required={required}
          className={INPUT}
        />
      )}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function Select({
  name,
  label,
  options,
  defaultValue,
  blank,
}: {
  name: string;
  label: string;
  options: readonly string[];
  defaultValue: string;
  blank?: string;
}) {
  const id = `brief-${name}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select id={id} name={name} defaultValue={defaultValue} className={INPUT}>
        {blank ? <option value="">{blank}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option.toLowerCase().replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The fields a person writes (docs/P4_SPEC.md §7). Evidence-backed fields -
 * claims, prohibitions, rules, link targets - are not here on purpose: they
 * come from the package and are carried from version to version unchanged,
 * so a brief cannot be talked into a claim by typing it.
 */
export function BriefEditForm({
  websiteId,
  workItemId,
  briefId,
  defaults,
  createsNewVersion,
}: {
  websiteId: string;
  workItemId: string;
  briefId: string | null;
  defaults: BriefFormDefaults;
  createsNewVersion: boolean;
}) {
  const [state, action, pending] = useActionState(saveBriefAction, initial);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      {briefId ? <input type="hidden" name="__briefId" value={briefId} /> : null}

      <Text name="title" label="Title" defaultValue={defaults.title} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          name="contentType"
          label="Content type"
          options={CONTENT_TYPES}
          defaultValue={defaults.contentType || "OTHER"}
        />
        <Select
          name="searchIntent"
          label="Search intent"
          options={SEARCH_INTENTS}
          defaultValue={defaults.searchIntent}
          blank="Not stated"
        />
      </div>
      <Text
        name="primaryConversion"
        label="Primary conversion"
        defaultValue={defaults.primaryConversion}
      />
      <Text name="audience" label="Audience" defaultValue={defaults.audience} rows={2} />
      <Text
        name="customerProblem"
        label="Customer problem"
        defaultValue={defaults.customerProblem}
        rows={3}
      />
      <Text
        name="desiredOutcome"
        label="Desired outcome"
        defaultValue={defaults.desiredOutcome}
        rows={2}
      />
      <Text
        name="recommendedAngle"
        label="Recommended angle"
        defaultValue={defaults.recommendedAngle}
        rows={3}
      />
      <Text
        name="keyQuestions"
        label="Key questions"
        defaultValue={defaults.keyQuestions}
        rows={4}
        hint="One question per line."
      />
      <Text
        name="requiredSections"
        label="Required sections"
        defaultValue={defaults.requiredSections}
        rows={5}
        hint="One per line, as: Heading | why it is there"
      />
      <Text
        name="optionalSections"
        label="Optional sections"
        defaultValue={defaults.optionalSections}
        rows={3}
        hint="One per line, as: Heading | why it is there"
      />
      <Text
        name="externalEvidenceRequirements"
        label="External evidence the piece will need"
        defaultValue={defaults.externalEvidenceRequirements}
        rows={3}
        hint="One per line. Facts nobody has approved yet: a customer count, a price, a statistic."
      />
      <Text
        name="brandVoiceNotes"
        label="Brand voice notes"
        defaultValue={defaults.brandVoiceNotes}
        rows={2}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending
            ? "Saving…"
            : createsNewVersion
              ? "Save as a new version"
              : briefId
                ? "Save draft"
                : "Create brief"}
        </button>
        <span className="text-muted-foreground text-xs">
          {createsNewVersion
            ? "The version you started from stays exactly as approved."
            : "Saving keeps this version a draft until someone requests review."}
        </span>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
