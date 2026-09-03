import { marketName } from "@/lib/markets";
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
];

export function ContextView({ version }: { version: BusinessContextVersion }) {
  return (
    <dl className="divide-border border-border divide-y rounded-lg border">
      {TEXT_FIELDS.map(([field, label]) => {
        const value = version[field];
        // A market is stored as a code and read as a name. An older approved
        // version may hold a sentence; marketName hands that back unchanged.
        const shown =
          field === "primaryMarket" && typeof value === "string" ? marketName(value) : value;
        return (
          <Row key={field} label={label}>
            {typeof shown === "string" && shown.length > 0 ? shown : <NotProvided />}
          </Row>
        );
      })}
      {LIST_FIELDS.map(([field, label]) => {
        const value = version[field];
        const raw = Array.isArray(value) ? (value as string[]) : [];
        const items =
          field === "additionalMarkets" ? raw.map((code) => marketName(code) ?? code) : raw;
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
