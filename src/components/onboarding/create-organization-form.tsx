"use client";

import { useActionState } from "react";

import {
  createOrganizationAction,
  type CreateOrganizationState,
} from "@/server/actions/organization";

const initialState: CreateOrganizationState = {};

export function CreateOrganizationForm() {
  const [state, formAction, pending] = useActionState(
    createOrganizationAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-5">
      <Field
        name="organizationName"
        label="Organization name"
        hint="Usually your company name."
        placeholder="The Creative SEO"
        error={state.fieldErrors?.organizationName}
      />
      <Field
        name="workspaceName"
        label="Workspace name"
        hint="A team or client grouping inside the organization."
        placeholder="SEO Team"
        defaultValue="SEO Team"
        error={state.fieldErrors?.workspaceName}
      />

      {state.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="bg-foreground text-background focus-visible:ring-ring inline-flex h-10 w-full items-center justify-center rounded-md px-4 text-sm font-medium transition-opacity focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  placeholder,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  hint: string;
  placeholder: string;
  defaultValue?: string;
  error?: string;
}) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        required
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-describedby={error ? errorId : hintId}
        aria-invalid={error ? true : undefined}
        className="border-border focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
      />
      {error ? (
        <p id={errorId} className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
    </div>
  );
}
