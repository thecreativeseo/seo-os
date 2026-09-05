import type { ReconciledClaim } from "@/lib/content/reconcile";
import { evidenceSourceLabel } from "@/lib/content/draft-ux";

/**
 * The pinned brief as constraints (M4.4 §3): what the draft is for, who it
 * is for, what it must cover, what it may claim and what it must not, the
 * rules that apply and the pages it may link to. Rendered from data the
 * service assembled, with stale claims judged against what is approved now.
 */

export type BriefPanelData = {
  version: number;
  status: string;
  title: string;
  contentType: string;
  searchIntent: string | null;
  audience: string | null;
  customerProblem: string | null;
  desiredOutcome: string | null;
  recommendedAngle: string | null;
  primaryConversion: string | null;
  brandVoiceNotes: string | null;
  businessGoal: { title: string } | null;
  primaryKeyword: { keyword: string } | null;
  secondaryKeywords: { keyword: string }[];
  targetPage: { path: string } | null;
  keyQuestions: string[];
  requiredSections: { heading: string; purpose: string }[];
  optionalSections: { heading: string; purpose: string }[];
  validClaims: ReconciledClaim[];
  staleClaims: ReconciledClaim[];
  prohibitedClaims: { text: string; source: string }[];
  rules: { rule: string; severity: string; constraint: string | null }[];
  linkTargets: { path: string | null; anchorText: string; reason: string }[];
  targetLength: string;
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h3>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function List({ items, empty }: { items: React.ReactNode[]; empty: string }) {
  if (items.length === 0) return <p className="text-muted-foreground text-xs">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function words(value: string): string {
  const lower = value.toLowerCase().replaceAll("_", " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function BriefPanel({
  brief,
  mismatch,
}: {
  brief: BriefPanelData;
  mismatch: { approvedVersion: number } | null;
}) {
  return (
    <section aria-labelledby="brief-panel-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="brief-panel-heading" className="text-sm font-medium">
          Draft based on Brief v{brief.version}
        </h2>
        {mismatch ? (
          <p className="text-sm">
            <span className="font-medium">
              This draft is based on Brief v{brief.version}. Brief v{mismatch.approvedVersion} is
              now approved.
            </span>{" "}
            <span className="text-muted-foreground">The draft was not moved.</span>
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {brief.status === "APPROVED" ? "The approved version." : words(brief.status)}
          </p>
        )}
        <p className="text-sm font-medium">{brief.title}</p>
        <p className="text-muted-foreground text-xs">
          {words(brief.contentType)}
          {brief.searchIntent ? ` · ${words(brief.searchIntent)} intent` : ""}
        </p>
      </div>

      <Block title="Audience">
        <p>{brief.audience ?? <span className="text-muted-foreground">Not stated</span>}</p>
        {brief.customerProblem ? (
          <p className="text-muted-foreground text-xs">Problem: {brief.customerProblem}</p>
        ) : null}
        {brief.desiredOutcome ? (
          <p className="text-muted-foreground text-xs">Outcome: {brief.desiredOutcome}</p>
        ) : null}
      </Block>

      {brief.recommendedAngle || brief.primaryConversion || brief.brandVoiceNotes ? (
        <Block title="Angle and voice">
          {brief.recommendedAngle ? <p>{brief.recommendedAngle}</p> : null}
          {brief.primaryConversion ? (
            <p className="text-muted-foreground text-xs">Conversion: {brief.primaryConversion}</p>
          ) : null}
          {brief.brandVoiceNotes ? (
            <p className="text-muted-foreground text-xs">Voice: {brief.brandVoiceNotes}</p>
          ) : null}
        </Block>
      ) : null}

      <Block title="Goal, keyword, page">
        <p>
          {brief.businessGoal ? (
            brief.businessGoal.title
          ) : (
            <span className="text-muted-foreground">No business goal linked</span>
          )}
        </p>
        <p>
          {brief.primaryKeyword ? (
            <>
              <span className="text-muted-foreground text-xs">Primary keyword: </span>
              {brief.primaryKeyword.keyword}
            </>
          ) : (
            <span className="text-muted-foreground text-xs">No primary keyword</span>
          )}
        </p>
        {brief.secondaryKeywords.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Secondary: {brief.secondaryKeywords.map((row) => row.keyword).join(", ")}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {brief.targetPage ? (
            <>
              Target page: <span className="font-mono">{brief.targetPage.path}</span>
            </>
          ) : (
            "New content — no page yet"
          )}
        </p>
      </Block>

      <Block title="Key questions">
        <List items={brief.keyQuestions} empty="None listed." />
      </Block>

      <Block title="Required sections, in order">
        {brief.requiredSections.length === 0 ? (
          <p className="text-muted-foreground text-xs">None listed.</p>
        ) : (
          <ol className="list-decimal space-y-0.5 pl-5">
            {brief.requiredSections.map((section) => (
              <li key={section.heading}>
                {section.heading}
                <span className="text-muted-foreground text-xs"> — {section.purpose}</span>
              </li>
            ))}
          </ol>
        )}
        {brief.optionalSections.length > 0 ? (
          <p className="text-muted-foreground mt-1 text-xs">
            Optional: {brief.optionalSections.map((section) => section.heading).join(", ")}
          </p>
        ) : null}
      </Block>

      <Block title="Claims the draft may make">
        <List
          items={brief.validClaims.map((claim) => (
            <span key={claim.evidenceId}>
              {claim.text}
              <span className="text-muted-foreground text-xs">
                {" "}
                — approved {evidenceSourceLabel(claim.evidenceId)}
              </span>
            </span>
          ))}
          empty="No approved claims in this brief."
        />
      </Block>

      {brief.staleClaims.length > 0 ? (
        <Block title="Claims no longer supported">
          <ul className="space-y-0.5 rounded-lg border border-red-300 p-2 text-xs dark:border-red-900">
            {brief.staleClaims.map((claim) => (
              <li key={claim.evidenceId}>
                <span className="font-medium">Stale:</span> “{claim.text}” — {claim.reason}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      <Block title="Prohibited claims and topics">
        <List
          items={brief.prohibitedClaims.map((claim) => (
            <span key={claim.text}>
              {claim.text}
              <span className="text-muted-foreground text-xs"> — {words(claim.source)}</span>
            </span>
          ))}
          empty="None recorded."
        />
      </Block>

      <Block title="SEO rules">
        <List
          items={brief.rules.map((rule) => (
            <span key={rule.rule}>
              <span className="text-muted-foreground text-xs">[{words(rule.severity)}] </span>
              {rule.rule}
              {rule.constraint ? (
                <span className="text-muted-foreground text-xs"> — {rule.constraint}</span>
              ) : null}
            </span>
          ))}
          empty="No active rules recorded."
        />
      </Block>

      <Block title="Internal link targets">
        <List
          items={brief.linkTargets.map((target, index) => (
            <span key={`${target.path}-${index}`}>
              <span className="font-mono text-xs">{target.path ?? "page"}</span>
              <span className="text-muted-foreground text-xs">
                {" "}
                — “{target.anchorText}”: {target.reason}
              </span>
            </span>
          ))}
          empty="None named; generated text will not link out."
        />
      </Block>

      <Block title="Target length">
        <p>{brief.targetLength}</p>
      </Block>
    </section>
  );
}
