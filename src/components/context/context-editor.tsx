"use client";

import { MARKETS, MAX_ADDITIONAL_MARKETS, marketName, resolveMarketCode } from "@/lib/markets";
import { useActionState, useRef, useState } from "react";

import { saveContextDraftAction, type ContextActionState } from "@/server/actions/business-context";
import { FIELD_HELP } from "@/components/context/field-help";
import { FieldHelp } from "@/components/ui/field-help";
import type { BusinessContextVersion } from "@/generated/prisma/client";

const initial: ContextActionState = {};

/**
 * Editor for an open draft.
 *
 * Three distinct actions, deliberately not collapsed into one:
 *
 *   Save changes    persists the draft
 *   Discard changes reverts the form to the last saved values (nothing leaves the
 *                   browser — this undoes typing, not history)
 *
 * Discarding the draft itself is a decision about the version, not about typing,
 * so it lives beside Publish on the page rather than in this form.
 *
 * Approved versions are never editable here; this component is only rendered for a
 * draft, and the service and database both reject an approved row regardless.
 */

const TEXT_FIELDS = [
  ["companySummary", "Company summary", true],
  ["productService", "Product / service", true],
  ["businessModel", "Business model", false],
  ["primaryCustomer", "Primary customer", true],
  ["primaryConversion", "Primary conversion", false],
  ["competitorSummary", "Competitor summary", true],
  ["brandVoice", "Brand voice", true],
] as const;

const LIST_FIELDS = [
  ["buyerRoles", "Buyer roles"],
  ["additionalMarkets", "Additional markets"],
  ["languages", "Languages"],
  ["secondaryConversions", "Secondary conversions"],
  ["businessPriorities", "Business priorities"],
  ["seoPriorities", "SEO priorities"],
  ["differentiators", "Differentiators"],
  ["priorityTopics", "Priority topics"],
  ["avoidTopics", "Topics to avoid"],
  ["approvedClaims", "Approved claims"],
  ["prohibitedClaims", "Prohibited claims"],
] as const;

export function ContextEditor({
  websiteId,
  version,
}: {
  websiteId: string;
  version: BusinessContextVersion;
}) {
  const [saveState, saveAction, saving] = useActionState(saveContextDraftAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);

  return (
    <div className="space-y-4">
      <form
        ref={formRef}
        action={saveAction}
        onInput={() => setDirty(true)}
        onChange={() => setDirty(true)}
        onSubmit={() => setDirty(false)}
        className="space-y-5"
      >
        <input type="hidden" name="__websiteId" value={websiteId} />
        <input type="hidden" name="__versionId" value={version.id} />

        {TEXT_FIELDS.map(([field, label, multiline]) => (
          <TextField
            key={field}
            name={field}
            label={label}
            multiline={multiline}
            defaultValue={(version[field] as string | null) ?? ""}
          />
        ))}

        {/* A market is a code chosen from the list rather than typed: keyword
            identity and the data connectors both key off it. A version that
            predates this rule may hold text the list cannot show; saving then
            asks for a choice rather than carrying the text forward. */}
        <div className="space-y-1.5">
          <label htmlFor="ctx-primaryMarket" className="block text-sm font-medium">
            Primary market
          </label>
          <select
            id="ctx-primaryMarket"
            name="primaryMarket"
            defaultValue={resolveMarketCode(version.primaryMarket) ?? ""}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">Not set</option>
            {MARKETS.map((market) => (
              <option key={market.code} value={market.code}>
                {market.name}
              </option>
            ))}
          </select>
          {version.primaryMarket && resolveMarketCode(version.primaryMarket) === null ? (
            <p className="text-muted-foreground text-xs">
              Currently recorded as &ldquo;{version.primaryMarket}&rdquo;. Choose the country it
              means.
            </p>
          ) : null}
        </div>

        {LIST_FIELDS.map(([field, label]) => (
          <ListField
            key={field}
            name={field}
            label={
              field === "additionalMarkets"
                ? `${label} (up to ${MAX_ADDITIONAL_MARKETS}, one country per line)`
                : label
            }
            defaultValue={((version[field] as string[] | null) ?? [])
              .map((entry) =>
                field === "additionalMarkets" ? (marketName(entry) ?? entry) : entry,
              )
              .join("\n")}
          />
        ))}

        <div className="border-border flex flex-wrap items-center gap-3 border-t pt-5">
          <button
            type="submit"
            disabled={saving}
            className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>

          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => {
              formRef.current?.reset();
              setDirty(false);
            }}
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-40"
          >
            Discard changes
          </button>

          {saveState.saved && !dirty ? (
            <span aria-live="polite" className="text-muted-foreground text-xs">
              Saved
            </span>
          ) : null}
          {dirty ? <span className="text-muted-foreground text-xs">Unsaved changes</span> : null}
        </div>

        {saveState.error ? (
          <p role="alert" className="text-sm text-red-600">
            {saveState.error}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function TextField({
  name,
  label,
  defaultValue,
  multiline,
}: {
  name: string;
  label: string;
  defaultValue: string;
  multiline: boolean;
}) {
  const id = `ctx-${name}`;
  const base =
    "border-border focus-visible:ring-ring w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {FIELD_HELP[name] ? <FieldHelp text={FIELD_HELP[name]} /> : null}
      </div>
      {multiline ? (
        <textarea
          id={id}
          name={name}
          rows={3}
          defaultValue={defaultValue}
          placeholder="Leave blank if unknown"
          className={`${base} py-2`}
        />
      ) : (
        <input
          id={id}
          name={name}
          defaultValue={defaultValue}
          placeholder="Leave blank if unknown"
          className={`${base} h-9`}
        />
      )}
    </div>
  );
}

function ListField({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: string;
}) {
  const id = `ctx-${name}`;
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {FIELD_HELP[name] ? <FieldHelp text={FIELD_HELP[name]} /> : null}
      </div>
      <textarea
        id={id}
        name={name}
        rows={3}
        defaultValue={defaultValue}
        aria-describedby={hintId}
        placeholder="One per line"
        className="border-border focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
      />
      <p id={hintId} className="text-muted-foreground text-xs">
        One per line. Blank lines are ignored.
      </p>
    </div>
  );
}
