"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { saveStepAction, type StepFormState } from "@/server/actions/onboarding";
import { useAutosave } from "@/components/onboarding/use-autosave";
import { normalizeDomain } from "@/lib/domain/normalize-domain";
import {
  CMS_OPTIONS,
  CONVERSION_OPTIONS,
  GOAL_TEMPLATES,
  SEO_PRIORITY_OPTIONS,
  WEBSITE_TYPE_OPTIONS,
  type StepAnswers,
} from "@/lib/onboarding/schemas";
import { previousStep, type OnboardingStepSlug } from "@/lib/onboarding/steps";
import { CONNECTION_PROVIDERS } from "@/lib/connections/registry";

const initialState: StepFormState = {};

type Row = { name: string; domain: string; notes: string };
type GoalRow = { title: string; businessObjective: string; primaryMetric: string };

export function StepForm({
  step,
  title,
  sessionId,
  answers,
  draft,
  website,
  competitors,
  goals,
}: {
  step: OnboardingStepSlug;
  title: string;
  sessionId: string;
  answers: StepAnswers;
  draft: Record<string, unknown>;
  website: { domain: string; normalizedDomain: string } | null;
  competitors: Row[];
  goals: GoalRow[];
}) {
  const [state, formAction, pending] = useActionState(saveStepAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const { status, schedule } = useAutosave(formRef);
  const back = previousStep(step);

  return (
    <form
      ref={formRef}
      action={formAction}
      onInput={schedule}
      onChange={schedule}
      className="space-y-8"
    >
      <input type="hidden" name="__sessionId" value={sessionId} />
      <input type="hidden" name="__step" value={step} />

      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <span
          aria-live="polite"
          className="text-muted-foreground shrink-0 text-xs tabular-nums"
        >
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </header>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <div className="space-y-6">
        {step === "website" ? (
          <WebsiteStep answers={answers} draft={draft} website={website} />
        ) : null}
        {step === "business" ? <BusinessStep answers={answers} draft={draft} /> : null}
        {step === "customer" ? <CustomerStep answers={answers} draft={draft} /> : null}
        {step === "conversion" ? <ConversionStep answers={answers} /> : null}
        {step === "market" ? <MarketStep answers={answers} draft={draft} /> : null}
        {step === "competitors" ? <CompetitorsStep rows={competitors} /> : null}
        {step === "goals" ? <GoalsStep rows={goals} /> : null}
        {step === "seo-priorities" ? <SeoPrioritiesStep answers={answers} /> : null}
        {step === "cms" ? <CmsStep answers={answers} /> : null}
        {step === "connections" ? <ConnectionsStep /> : null}
        {step === "review" ? <ReviewStep answers={answers} website={website} /> : null}
      </div>

      <div className="border-border flex items-center gap-3 border-t pt-5">
        {back ? (
          <Link
            href={`../${back}` as never}
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm"
          >
            Back
          </Link>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : step === "review" ? "Save draft" : "Save & continue"}
        </button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- primitives */

function Text({
  name,
  label,
  hint,
  placeholder,
  defaultValue,
  required,
  multiline,
}: {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const id = `field-${name}`;
  const hintId = `${id}-hint`;
  const className =
    "border-border focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none";

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required ? " *" : null}
      </label>
      {multiline ? (
        <textarea
          id={id}
          name={name}
          rows={4}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          aria-describedby={hint ? hintId : undefined}
          className={className}
        />
      ) : (
        <input
          id={id}
          name={name}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          aria-describedby={hint ? hintId : undefined}
          className={`${className} h-10 py-0`}
        />
      )}
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Select({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
}) {
  const id = `field-${name}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ""}
        className="border-border h-10 w-full rounded-md border px-3 text-sm"
      >
        <option value="">Not sure yet</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ---------------------------------------------------------------- steps */

/** Committed answer wins; an autosaved draft fills in when there is none. */
function fallback(
  committed: string | undefined,
  draft: Record<string, unknown>,
  key: string,
): string {
  if (committed !== undefined && committed !== "") return committed;
  const value = draft[key];
  return typeof value === "string" ? value : "";
}

function draftList(draft: Record<string, unknown>, key: string): string[] {
  const value = draft[key];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function WebsiteStep({
  answers,
  draft,
  website,
}: {
  answers: StepAnswers;
  draft: Record<string, unknown>;
  website: { domain: string; normalizedDomain: string } | null;
}) {
  const saved = answers.website;
  const [domain, setDomain] = useState(
    saved?.domain ?? website?.domain ?? fallback(undefined, draft, "domain"),
  );
  const preview = normalizeDomain(domain);

  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor="field-domain" className="block text-sm font-medium">
          Website domain *
        </label>
        <input
          id="field-domain"
          name="domain"
          required
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="example.com"
          aria-describedby="domain-preview"
          className="border-border focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <p id="domain-preview" className="text-muted-foreground text-xs">
          {domain.trim().length === 0
            ? "We will normalise this, for example https://www.Example.com/ becomes example.com."
            : preview.ok
              ? `Will be stored as ${preview.normalized}`
              : "That does not look like a valid domain yet."}
        </p>
      </div>
      <Text name="name" label="Website name" defaultValue={fallback(saved?.name, draft, "name")} />
      <Select
        name="websiteType"
        label="Website type"
        options={WEBSITE_TYPE_OPTIONS}
        defaultValue={fallback(saved?.websiteType, draft, "websiteType")}
      />
      <Text
        name="primaryLanguage"
        label="Primary language"
        defaultValue={fallback(saved?.primaryLanguage, draft, "primaryLanguage")}
      />
      <Text
        name="primaryMarket"
        label="Main market"
        defaultValue={fallback(saved?.primaryMarket, draft, "primaryMarket")}
      />
      <Text
        name="timezone"
        label="Timezone"
        defaultValue={fallback(saved?.timezone, draft, "timezone")}
      />
    </>
  );
}

function BusinessStep({
  answers,
  draft,
}: {
  answers: StepAnswers;
  draft: Record<string, unknown>;
}) {
  const saved = answers.business;
  return (
    <>
      <Text
        name="productService"
        label="Product or service"
        hint="What this website sells or supports."
        required
        multiline
        defaultValue={fallback(saved?.productService, draft, "productService")}
      />
      <Text
        name="businessModel"
        label="Business model"
        defaultValue={fallback(saved?.businessModel, draft, "businessModel")}
      />
      <Text
        name="companySummary"
        label="Company summary"
        multiline
        defaultValue={fallback(saved?.companySummary, draft, "companySummary")}
      />
    </>
  );
}

/** Repeatable single-value list, e.g. buyer roles or additional markets. */
function RepeatableList({
  name,
  label,
  hint,
  placeholder,
  values,
  addLabel,
}: {
  name: string;
  label: string;
  hint?: string;
  placeholder: string;
  values: string[];
  addLabel: string;
}) {
  const [items, setItems] = useState<string[]>(values.length > 0 ? values : [""]);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      {items.map((value, index) => (
        <div key={index} className="flex gap-2">
          <input
            name={name}
            defaultValue={value}
            placeholder={placeholder}
            aria-label={`${label} ${index + 1}`}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          />
          {items.length > 1 ? (
            <button
              type="button"
              aria-label={`Remove ${label} ${index + 1}`}
              onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
              className="border-border hover:bg-accent h-9 shrink-0 rounded-md border px-3 text-sm"
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setItems((current) => [...current, ""])}
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm"
      >
        {addLabel}
      </button>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function CustomerStep({
  answers,
  draft,
}: {
  answers: StepAnswers;
  draft: Record<string, unknown>;
}) {
  const saved = answers.customer;
  const roles = saved?.buyerRoles?.length ? saved.buyerRoles : draftList(draft, "buyerRoles");

  return (
    <>
      <Text
        name="primaryCustomer"
        label="Primary customer"
        required
        multiline
        defaultValue={fallback(saved?.primaryCustomer, draft, "primaryCustomer")}
      />
      <RepeatableList
        name="buyerRoles"
        label="Buyer roles"
        placeholder="Head of Marketing"
        values={roles}
        addLabel="Add another role"
        hint="The people involved in the buying decision."
      />
    </>
  );
}

function ConversionStep({ answers }: { answers: StepAnswers }) {
  const saved = answers.conversion?.primaryConversion ?? "";
  const known = CONVERSION_OPTIONS.find((option) => option === saved);
  const [choice, setChoice] = useState<string>(known ?? (saved ? "Other" : ""));

  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Primary conversion</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {CONVERSION_OPTIONS.map((option) => (
          <label
            key={option}
            className={`border-border flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm ${
              choice === option ? "bg-accent" : "hover:bg-accent/50"
            }`}
          >
            <input
              type="radio"
              name="primaryConversion"
              value={option}
              checked={choice === option}
              onChange={() => setChoice(option)}
              className="accent-foreground"
            />
            {option}
          </label>
        ))}
      </div>
      {choice === "Other" ? (
        <Text
          name="primaryConversionOther"
          label="Describe the action"
          defaultValue={known ? "" : saved}
        />
      ) : null}
    </fieldset>
  );
}

function MarketStep({
  answers,
  draft,
}: {
  answers: StepAnswers;
  draft: Record<string, unknown>;
}) {
  const saved = answers.market;
  const markets = saved?.additionalMarkets?.length
    ? saved.additionalMarkets
    : draftList(draft, "additionalMarkets");

  return (
    <>
      <Text
        name="primaryMarket"
        label="Primary market"
        required
        defaultValue={fallback(saved?.primaryMarket, draft, "primaryMarket")}
      />
      <Text
        name="primaryLanguage"
        label="Primary language"
        defaultValue={fallback(saved?.primaryLanguage, draft, "primaryLanguage")}
      />
      <RepeatableList
        name="additionalMarkets"
        label="Additional markets"
        placeholder="Singapore"
        values={markets}
        addLabel="Add another market"
      />
    </>
  );
}

function CompetitorsStep({ rows }: { rows: Row[] }) {
  const [items, setItems] = useState<Row[]>(
    rows.length > 0 ? rows : [{ name: "", domain: "", notes: "" }],
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">Add three to five where possible.</p>
      {items.map((row, index) => (
        <div key={index} className="border-border grid gap-3 rounded-md border p-4 sm:grid-cols-2">
          <input
            name="competitorName"
            defaultValue={row.name}
            placeholder="Competitor name"
            aria-label={`Competitor ${index + 1} name`}
            className="border-border h-9 rounded-md border px-3 text-sm"
          />
          <input
            name="competitorDomain"
            defaultValue={row.domain}
            placeholder="competitor.com"
            aria-label={`Competitor ${index + 1} domain`}
            className="border-border h-9 rounded-md border px-3 text-sm"
          />
          <input
            name="competitorNotes"
            defaultValue={row.notes}
            placeholder="Notes (optional)"
            aria-label={`Competitor ${index + 1} notes`}
            className="border-border h-9 rounded-md border px-3 text-sm sm:col-span-2"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => setItems((current) => [...current, { name: "", domain: "", notes: "" }])}
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm"
      >
        Add another competitor
      </button>
      <p className="text-muted-foreground text-xs">
        SEO OS does not classify competitors in this phase — everything you add is
        recorded as provided by you.
      </p>
    </div>
  );
}

function GoalsStep({ rows }: { rows: GoalRow[] }) {
  const [items, setItems] = useState<GoalRow[]>(
    rows.length > 0 ? rows : [{ title: "", businessObjective: "", primaryMetric: "" }],
  );

  return (
    <div className="space-y-4">
      {items.map((row, index) => (
        <div key={index} className="border-border space-y-3 rounded-md border p-4">
          <input
            name="goalTitle"
            defaultValue={row.title}
            list="goal-templates"
            placeholder="Generate qualified leads"
            aria-label={`Goal ${index + 1}`}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          />
          <input
            name="goalObjective"
            defaultValue={row.businessObjective}
            placeholder="Business objective (optional)"
            aria-label={`Goal ${index + 1} objective`}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          />
          <input
            name="goalMetric"
            defaultValue={row.primaryMetric}
            placeholder="Primary metric (optional)"
            aria-label={`Goal ${index + 1} metric`}
            className="border-border h-9 w-full rounded-md border px-3 text-sm"
          />
        </div>
      ))}
      <datalist id="goal-templates">
        {GOAL_TEMPLATES.map((template) => (
          <option key={template} value={template} />
        ))}
      </datalist>
      <button
        type="button"
        onClick={() =>
          setItems((current) => [
            ...current,
            { title: "", businessObjective: "", primaryMetric: "" },
          ])
        }
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm"
      >
        Add another goal
      </button>
      <p className="text-muted-foreground text-xs">
        Baselines stay empty until real data is connected — SEO OS will not invent a
        starting number.
      </p>
    </div>
  );
}

function SeoPrioritiesStep({ answers }: { answers: StepAnswers }) {
  const saved = new Set(answers["seo-priorities"]?.seoPriorities ?? []);

  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">SEO priorities</legend>
      {SEO_PRIORITY_OPTIONS.map((option) => (
        <label
          key={option}
          className="border-border hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm"
        >
          <input
            type="checkbox"
            name="seoPriorities"
            value={option}
            defaultChecked={saved.has(option)}
            className="accent-foreground"
          />
          {option}
        </label>
      ))}
    </fieldset>
  );
}

function CmsStep({ answers }: { answers: StepAnswers }) {
  const saved = answers.cms;
  return (
    <>
      <Select
        name="cms"
        label="CMS"
        options={CMS_OPTIONS}
        defaultValue={saved?.cms ?? "UNKNOWN"}
      />
      <Text
        name="publicationProcess"
        label="Publication process"
        multiline
        defaultValue={saved?.publicationProcess ?? ""}
      />
      <Text
        name="developerContact"
        label="Developer contact"
        defaultValue={saved?.developerContact ?? ""}
      />
    </>
  );
}

function ConnectionsStep() {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Nothing connects in this phase. These are the systems SEO OS is built to
        operate with, and when each becomes available.
      </p>
      <ul className="divide-border border-border divide-y rounded-md border">
        {CONNECTION_PROVIDERS.map((provider) => (
          <li key={provider.provider} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{provider.name}</p>
              <p className="text-muted-foreground truncate text-xs">{provider.purpose}</p>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">
              {provider.availability}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewStep({
  answers,
  website,
}: {
  answers: StepAnswers;
  website: { domain: string; normalizedDomain: string } | null;
}) {
  const rows: [string, string][] = [
    ["Website", website?.normalizedDomain ?? "Not provided"],
    ["Product / service", answers.business?.productService ?? "Not provided"],
    ["Primary customer", answers.customer?.primaryCustomer ?? "Not provided"],
    ["Primary conversion", answers.conversion?.primaryConversion ?? "Not provided"],
    ["Main market", answers.market?.primaryMarket ?? "Not provided"],
    [
      "SEO priorities",
      (answers["seo-priorities"]?.seoPriorities ?? []).join(", ") || "Not provided",
    ],
    ["CMS", answers.cms?.cms ?? "Not provided"],
  ];

  return (
    <div className="space-y-4">
      <dl className="divide-border border-border divide-y rounded-md border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[10rem_1fr] gap-4 px-4 py-3 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={value === "Not provided" ? "text-muted-foreground" : ""}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs">
        Anything left blank stays unknown. Approving this context arrives in the next
        milestone.
      </p>
    </div>
  );
}
