import type { BusinessContextVersion } from "@/generated/prisma/client";

/**
 * Renders a context version's content.
 *
 * A field the business never answered shows as "Not provided" in muted text, never
 * as a plausible-looking default. The distinction between "we know this" and "we
 * do not" is the whole point of the Business Context.
 */

const TEXT_FIELDS: [keyof BusinessContextVersion, string][] = [
  ["companySummary", "Company summary"],
  ["productService", "Product / service"],
  ["businessModel", "Business model"],
  ["primaryCustomer", "Primary customer"],
  ["primaryMarket", "Primary market"],
  ["primaryConversion", "Primary conversion"],
  ["competitorSummary", "Competitor summary"],
  ["brandVoice", "Brand voice"],
];

const LIST_FIELDS: [keyof BusinessContextVersion, string][] = [
  ["buyerRoles", "Buyer roles"],
  ["languages", "Languages"],
  ["secondaryConversions", "Secondary conversions"],
  ["businessPriorities", "Business priorities"],
  ["seoPriorities", "SEO priorities"],
  ["differentiators", "Differentiators"],
  ["priorityTopics", "Priority topics"],
  ["avoidTopics", "Topics to avoid"],
  ["approvedClaims", "Approved claims"],
  ["prohibitedClaims", "Prohibited claims"],
];

export function ContextView({ version }: { version: BusinessContextVersion }) {
  return (
    <dl className="divide-border border-border divide-y rounded-lg border">
      {TEXT_FIELDS.map(([field, label]) => {
        const value = version[field];
        return (
          <Row key={field} label={label}>
            {typeof value === "string" && value.length > 0 ? (
              value
            ) : (
              <NotProvided />
            )}
          </Row>
        );
      })}
      {LIST_FIELDS.map(([field, label]) => {
        const value = version[field];
        const items = Array.isArray(value) ? (value as string[]) : [];
        return (
          <Row key={field} label={label}>
            {items.length > 0 ? items.join(", ") : <NotProvided />}
          </Row>
        );
      })}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function NotProvided() {
  return <span className="text-muted-foreground/70 italic">Not provided</span>;
}
