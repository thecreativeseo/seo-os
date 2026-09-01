"use client";

import { useId } from "react";

/**
 * Field guidance tooltip.
 *
 * Opens on hover and on keyboard focus, so it is reachable without a mouse. The
 * trigger is a real button with aria-describedby pointing at the tooltip, and the
 * tooltip carries role="tooltip", so screen readers announce the explanation when
 * the trigger receives focus.
 */
export function FieldHelp({ text }: { text: string }) {
  const id = useId();

  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-describedby={id}
        aria-label="What is this field for?"
        className="border-border text-muted-foreground hover:border-foreground hover:text-foreground focus-visible:ring-ring flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none focus-visible:ring-2 focus-visible:outline-none"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="bg-foreground text-background pointer-events-none invisible absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-md px-3 py-2 text-xs leading-relaxed opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/** Label with an optional help tooltip, for form fields. */
export function LabelWithHelp({
  htmlFor,
  label,
  help,
  required,
}: {
  htmlFor: string;
  label: string;
  help?: string;
  required?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {required ? " *" : null}
      </label>
      {help ? <FieldHelp text={help} /> : null}
    </div>
  );
}
