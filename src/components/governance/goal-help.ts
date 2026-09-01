/**
 * Guidance for the Add a goal form.
 *
 * The placeholders are one worked example told across all five fields — the same
 * imagined goal, from objective through to where its baseline came from. A set of
 * unrelated examples would show the shape of each field but not how they relate,
 * which is the part people get wrong: a goal whose metric does not measure its
 * objective is the most common way this section becomes decorative.
 *
 * Placeholders are guidance, not defaults. Nothing here is ever submitted.
 */
export const GOAL_PLACEHOLDERS = {
  title: "Generate qualified leads from organic search",
  businessObjective: "Grow self-serve revenue without increasing paid spend",
  primaryMetric: "Demo requests from organic",
  baseline: "42",
  baselineSource: "HubSpot, trailing 90 days to 31 Aug",
} as const;

export const GOAL_HELP: Record<string, string> = {
  title:
    "What SEO needs to help the business accomplish, in one line. Name the outcome, not the activity — “generate qualified leads”, not “publish more posts”.",
  businessObjective:
    "The business result this serves. If SEO succeeded completely, what would the business have that it does not have now?",
  primaryMetric:
    "The single number that would move if this goal were met. It should measure the objective, not the effort: demo requests rather than pages published.",
  baseline:
    "Where that metric stands today, if you know. Leave blank if you do not — SEO OS records unknown as unknown rather than assuming zero, and an invented starting point would make every later comparison wrong.",
  baselineSource:
    "Where the baseline number came from, so it can be checked later. A tool and a date range is enough.",
};

/** From the P0 blueprint. Offered as suggestions; anything else is accepted. */
export const GOAL_TEMPLATES = [
  "Generate qualified leads",
  "Generate demos",
  "Grow pipeline",
  "Increase trials",
  "Increase revenue",
  "Enter a new market",
  "Build category visibility",
  "Increase qualified organic traffic",
  "Improve AI visibility",
  "Reduce paid acquisition dependency",
] as const;
