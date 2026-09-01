"use client";

import { useActionState } from "react";

import { LabelWithHelp } from "@/components/ui/field-help";
import type { GovernanceState } from "@/server/actions/governance";

const initial: GovernanceState = {};

type Action = (
  previous: GovernanceState,
  formData: FormData,
) => Promise<GovernanceState>;

/**
 * A form that submits a governance action, with hidden tenant identifiers and
 * server-returned errors surfaced in place.
 */
export function ActionForm({
  action,
  websiteId,
  hidden,
  submitLabel,
  pendingLabel,
  variant = "primary",
  children,
  className,
}: {
  action: Action;
  websiteId: string;
  hidden?: Record<string, string>;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "quiet";
  children?: React.ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initial);

  const button =
    variant === "primary"
      ? "bg-foreground text-background h-9 px-4 text-sm font-medium"
      : variant === "secondary"
        ? "border-border hover:bg-accent border h-9 px-4 text-sm"
        : "text-muted-foreground hover:text-foreground h-8 px-2 text-xs";

  return (
    <form action={formAction} className={className ?? "space-y-3"}>
      <input type="hidden" name="__websiteId" value={websiteId} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={`inline-flex items-center rounded-md transition-colors disabled:opacity-60 ${button}`}
        >
          {pending ? (pendingLabel ?? "Saving…") : submitLabel}
        </button>
        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function Field({
  name,
  label,
  placeholder,
  defaultValue,
  required,
  multiline,
  hint,
  help,
  list,
}: {
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  multiline?: boolean;
  hint?: string;
  help?: string;
  /** id of a <datalist> to offer suggestions from. */
  list?: string;
}) {
  const id = `gov-${name}`;
  const hintId = `${id}-hint`;
  const base =
    "border-border focus-visible:ring-ring w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none";

  return (
    <div className="space-y-1.5">
      <LabelWithHelp htmlFor={id} label={label} help={help} required={required} />
      {multiline ? (
        <textarea
          id={id}
          name={name}
          rows={3}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          aria-describedby={hint ? hintId : undefined}
          className={`${base} py-2`}
        />
      ) : (
        <input
          id={id}
          name={name}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          list={list}
          aria-describedby={hint ? hintId : undefined}
          className={`${base} h-9`}
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

export function Choice({
  name,
  label,
  options,
  defaultValue,
  includeBlank,
  help,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
  includeBlank?: string;
  help?: string;
}) {
  const id = `gov-${name}`;
  return (
    <div className="space-y-1.5">
      <LabelWithHelp htmlFor={id} label={label} help={help} />
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ""}
        className="border-border h-9 w-full rounded-md border px-3 text-sm"
      >
        {includeBlank ? <option value="">{includeBlank}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
    </header>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
      {children}
    </p>
  );
}

export function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wide">
      {children}
    </span>
  );
}
