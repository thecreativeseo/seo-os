/**
 * Inline edit, collapsed by default.
 *
 * A native <details> rather than a toggle with state: it is keyboard operable and
 * screen-reader announced without any JavaScript, and it keeps the list scannable —
 * a page of expanded forms is harder to read than a page of records.
 *
 * Editing is deliberately one level quieter than the lifecycle actions beside it.
 * Correcting wording is not a governance decision; activating or archiving is.
 */
export function EditDisclosure({
  label = "Edit",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer items-center rounded-md text-xs focus-visible:ring-2 focus-visible:outline-none">
        {label}
      </summary>
      <div className="border-border mt-3 rounded-md border p-4">{children}</div>
    </details>
  );
}
