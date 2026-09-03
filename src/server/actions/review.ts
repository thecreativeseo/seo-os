"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  DecisionError,
  decide,
  type DecisionInput,
  type RecommendationModifications,
} from "@/server/services/decision";
import { LEVELS, PRIORITY_LEVELS, RECOMMENDATION_TYPES } from "@/lib/ai/schemas/page-diagnosis";

/**
 * Human review (docs/P3_SPEC.md §24, §36).
 *
 * The action does two things and nothing else: prove who is asking, and hand
 * the form to the service. The website ID names which tenant the request is
 * about, and `requireWebsiteAccess` decides whether this user may act there at
 * APPROVE level; the service checks the same thing again. Nothing in the form
 * can grant authority — a decision field, an override, a role — and nothing in
 * the form is trusted to describe the recommendation, which is read from the
 * database under the resolved tenant.
 */

export type ReviewActionState = { error?: string; decided?: string };

const DECISIONS = new Set(["APPROVED", "MODIFIED", "REJECTED", "NEEDS_EVIDENCE"]);

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** A modified field is only sent if the reviewer typed into it. */
function modificationsFrom(formData: FormData): RecommendationModifications {
  const changes: RecommendationModifications = {};

  const title = text(formData, "mod_title");
  if (title) changes.title = title;

  const summary = text(formData, "mod_summary");
  if (summary) changes.summary = summary;

  const rationale = text(formData, "mod_rationale");
  if (rationale) changes.rationale = rationale;

  const effect = text(formData, "mod_expectedEffectDescription");
  if (effect) changes.expectedEffectDescription = effect;

  const type = text(formData, "mod_type");
  if ((RECOMMENDATION_TYPES as readonly string[]).includes(type)) {
    changes.type = type as RecommendationModifications["type"];
  }

  const priority = text(formData, "mod_priority");
  if ((PRIORITY_LEVELS as readonly string[]).includes(priority)) {
    changes.priority = priority as RecommendationModifications["priority"];
  }

  const effort = text(formData, "mod_effort");
  if ((LEVELS as readonly string[]).includes(effort)) {
    changes.effort = effort as RecommendationModifications["effort"];
  }

  const risk = text(formData, "mod_risk");
  if ((LEVELS as readonly string[]).includes(risk)) {
    changes.risk = risk as RecommendationModifications["risk"];
  }

  return changes;
}

export async function decideRecommendationAction(
  _previous: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const websiteId = text(formData, "__websiteId");
  const recommendationId = text(formData, "__recommendationId");
  const decision = text(formData, "decision");

  if (!DECISIONS.has(decision)) {
    return { error: "Choose a decision." };
  }

  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  const reason = text(formData, "reason");
  const overrideRuleId = text(formData, "overrideRuleId");
  const overrideReason = text(formData, "overrideReason");

  let input: DecisionInput;

  switch (decision) {
    case "APPROVED":
      input = {
        decision,
        reason: reason || undefined,
        override: overrideRuleId ? { ruleId: overrideRuleId, reason: overrideReason } : undefined,
      };
      break;
    case "MODIFIED":
      input = { decision, reason: reason || undefined, modifications: modificationsFrom(formData) };
      break;
    case "REJECTED":
      input = { decision, reason };
      break;
    default:
      input = { decision: "NEEDS_EVIDENCE", reason };
  }

  try {
    const result = await decide(context, recommendationId, input);
    revalidatePath(`/websites/${websiteId}`, "layout");
    return { decided: result.decision.decision };
  } catch (error) {
    if (error instanceof DecisionError) {
      return { error: error.message };
    }
    throw error;
  }
}
