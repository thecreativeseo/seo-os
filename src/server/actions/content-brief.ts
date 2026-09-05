"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { ContentWorkError } from "@/server/services/content-work";
import {
  ContentBriefError,
  approveBrief,
  archiveBrief,
  createManualBrief,
  generateBrief,
  requestBriefReview,
  saveBrief,
  type BriefInput,
} from "@/server/services/content-brief";
import type { BriefSection } from "@/lib/ai/schemas/content-brief";
import type { KeywordIntent } from "@/generated/prisma/client";

/**
 * Briefs (docs/P4_SPEC.md §7, §11). Each action proves who is asking, hands
 * the form to the service, and turns the service's refusals into sentences.
 * Generation and editing need WRITE; approval and archiving need REVIEW, and
 * the service checks again. Nothing in a form names a version's status or an
 * evidence ID - those are the service's to decide.
 */

export type BriefActionState = { error?: string; message?: string };

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function lines(formData: FormData, key: string): string[] {
  return text(formData, key)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** One section per line, as "Heading | why it is there". */
function sections(formData: FormData, key: string): BriefSection[] {
  return lines(formData, key).map((line) => {
    const [heading, ...rest] = line.split("|");
    return { heading: (heading ?? "").trim(), purpose: rest.join("|").trim() };
  });
}

function inputFrom(formData: FormData): BriefInput {
  const intent = text(formData, "searchIntent").trim();
  return {
    title: text(formData, "title"),
    contentType: text(formData, "contentType"),
    searchIntent: intent ? (intent as KeywordIntent) : null,
    primaryConversion: text(formData, "primaryConversion"),
    audience: text(formData, "audience"),
    customerProblem: text(formData, "customerProblem"),
    desiredOutcome: text(formData, "desiredOutcome"),
    recommendedAngle: text(formData, "recommendedAngle"),
    keyQuestions: lines(formData, "keyQuestions"),
    requiredSections: sections(formData, "requiredSections"),
    optionalSections: sections(formData, "optionalSections"),
    externalEvidenceRequirements: lines(formData, "externalEvidenceRequirements"),
    brandVoiceNotes: text(formData, "brandVoiceNotes"),
  };
}

function sentence(error: unknown): string | null {
  if (error instanceof ContentBriefError || error instanceof ContentWorkError) {
    return error.message;
  }
  return null;
}

export async function generateBriefAction(
  _previous: BriefActionState,
  formData: FormData,
): Promise<BriefActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let version: number;
  try {
    const outcome = await generateBrief(context, workItemId);
    if (!outcome.ok) {
      return { error: outcome.error.message };
    }
    version = outcome.brief.version;
  } catch (error) {
    const message = sentence(error);
    if (message) return { error: message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(`/websites/${websiteId}/content/${workItemId}/brief?version=${version}`);
}

export async function saveBriefAction(
  _previous: BriefActionState,
  formData: FormData,
): Promise<BriefActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const briefId = text(formData, "__briefId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let version: number;
  try {
    if (briefId) {
      const saved = await saveBrief(context, briefId, inputFrom(formData));
      version = saved.brief.version;
    } else {
      const created = await createManualBrief(context, workItemId, inputFrom(formData));
      version = created.version;
    }
  } catch (error) {
    const message = sentence(error);
    if (message) return { error: message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(`/websites/${websiteId}/content/${workItemId}/brief?version=${version}`);
}

export async function requestBriefReviewAction(
  _previous: BriefActionState,
  formData: FormData,
): Promise<BriefActionState> {
  const websiteId = text(formData, "__websiteId");
  const briefId = text(formData, "__briefId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await requestBriefReview(context, briefId);
  } catch (error) {
    const message = sentence(error);
    if (message) return { error: message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return { message: "Review requested." };
}

export async function approveBriefAction(
  _previous: BriefActionState,
  formData: FormData,
): Promise<BriefActionState> {
  const websiteId = text(formData, "__websiteId");
  const briefId = text(formData, "__briefId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });

  try {
    await approveBrief(context, briefId);
  } catch (error) {
    const message = sentence(error);
    if (message) return { error: message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return { message: "Brief approved." };
}

export async function archiveBriefAction(
  _previous: BriefActionState,
  formData: FormData,
): Promise<BriefActionState> {
  const websiteId = text(formData, "__websiteId");
  const briefId = text(formData, "__briefId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });

  try {
    await archiveBrief(context, briefId);
  } catch (error) {
    const message = sentence(error);
    if (message) return { error: message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return { message: "Version archived." };
}
