import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { isRetrySafeFailure } from "@/lib/execution/errors";
import { parseCmsBaseUrl } from "@/lib/cms/url";
import { cmsDraftState, type CmsDraftAction, type CmsDraftState } from "@/lib/cms/draft-ux";
import { isUnresolved } from "@/server/services/cms-execution";
import type {
  CmsEntityType,
  ExecutionVerificationStatus,
  VerificationType,
} from "@/generated/prisma/client";

/**
 * What the CMS Drafts screen reads (M6.4 §12).
 *
 * A view model, and only that: it decides nothing and writes nothing. Which
 * actions a person may take is computed from the same rules the actions
 * themselves enforce, so a control is never offered that the server would then
 * refuse — but the server refuses anyway, because a screen is not a permission
 * system.
 *
 * Nothing here reaches WordPress. Every field comes from rows SEO OS already
 * holds, which is why the page is fast and why it says "as far as we know"
 * rather than "as it is right now". Re-verify is the button that goes and looks.
 */

export type CmsDraftVerification = {
  type: VerificationType;
  status: ExecutionVerificationStatus;
  /** True for the checks that decide whether this is verified. */
  required: boolean;
  /** Safe summary only: a difference kind and fingerprints, never content. */
  detail: string | null;
};

export type CmsDraftRow = {
  workItemId: string;
  title: string;
  /** The revision a person approved, by number and short hash. */
  revisionNumber: number | null;
  revisionHash: string | null;
  executionId: string | null;
  targetEntityType: CmsEntityType | null;
  state: CmsDraftState;
  /** The CMS's own word for the entity. "draft", or something to look at. */
  externalStatus: string | null;
  externalEntityId: string | null;
  /** Only ever a plain address the provider returned. Never a preview token. */
  externalUrl: string | null;
  siteHost: string | null;
  simulated: boolean;
  approvedByName: string | null;
  requestedByName: string | null;
  executedByName: string | null;
  approvedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  verifiedAt: Date | null;
  verifications: CmsDraftVerification[];
  /** The one act this row is currently open to. */
  nextAction: CmsDraftAction;
  /** Why there is no action, when there is none. */
  blockedReason: string | null;
};

/** Which checks decide verification, and which are advisory (M6.4 §23). */
const REQUIRED_VERIFICATIONS: ReadonlySet<VerificationType> = new Set<VerificationType>([
  "CMS_STATUS_DRAFT",
  "TITLE_MATCH",
  "CONTENT_PRESENT",
  "EXCERPT_MATCH",
]);

export type CmsConnectionReadiness = {
  configured: boolean;
  status: string;
  /** The site a draft would be created on. Never a credential-bearing URL. */
  siteHost: string | null;
  baseUrl: string | null;
  /** Whether a credential exists. Never the credential itself. */
  credentialConfigured: boolean;
  accountName: string | null;
  lastCheckedAt: Date | null;
  publishingMode: string | null;
  capabilities: {
    readContent: boolean | null;
    createPost: boolean | null;
    createPage: boolean | null;
  };
  /** The targets a person may actually choose, from discovered capability. */
  selectableTargets: CmsEntityType[];
  /** True when a draft could be created right now, connection-wise. */
  ready: boolean;
  reason: string | null;
};

/**
 * What the connection can currently do, as discovered rather than assumed.
 *
 * A capability that was never asked about reads as null — unknown — and is
 * never shown as granted. Unknown and refused both mean the target cannot be
 * chosen; they are distinguished because they are different facts about the
 * site, and the second is worth acting on.
 */
export async function getCmsConnectionReadiness(
  context: TenantContext,
): Promise<CmsConnectionReadiness> {
  const connection = await prisma.connection.findFirst({
    where: { provider: "WORDPRESS", ...websiteScope(context) },
    include: {
      credential: { select: { id: true } },
      capabilities: {
        select: { capability: true, entityType: true, granted: true },
      },
    },
  });

  const empty: CmsConnectionReadiness = {
    configured: false,
    status: "NOT_CONNECTED",
    siteHost: null,
    baseUrl: null,
    credentialConfigured: false,
    accountName: null,
    lastCheckedAt: null,
    publishingMode: null,
    capabilities: { readContent: null, createPost: null, createPage: null },
    selectableTargets: [],
    ready: false,
    reason: "No WordPress connection is configured for this website yet.",
  };

  if (!connection) return empty;

  const policy = await prisma.publishingPolicy.findFirst({
    where: { websiteId: context.website.id, connectionId: connection.id },
    select: { mode: true },
  });

  const found = (capability: string, entityType: CmsEntityType | null) =>
    connection.capabilities.find(
      (row) => row.capability === capability && row.entityType === entityType,
    );

  // Absent means never asked. It is not the same as refused, and neither grants.
  const readContent = found("READ_CONTENT", null)?.granted ?? null;
  const createPost = found("CREATE_DRAFT", "POST")?.granted ?? null;
  const createPage = found("CREATE_DRAFT", "PAGE")?.granted ?? null;

  const parsed = connection.baseUrl ? parseCmsBaseUrl(connection.baseUrl) : null;
  const selectableTargets: CmsEntityType[] = [
    ...(createPost === true ? (["POST"] as const) : []),
    ...(createPage === true ? (["PAGE"] as const) : []),
  ];

  const reason =
    connection.status !== "CONNECTED"
      ? "The WordPress connection is not connected. Test the connection on Data Sources."
      : !connection.credential
        ? "No application password is stored for this connection."
        : !parsed || !parsed.ok
          ? "The connection does not have a usable site address."
          : policy?.mode !== "DRAFT_ONLY"
            ? "The publishing policy for this connection does not permit creating drafts."
            : selectableTargets.length === 0
              ? "WordPress has not confirmed that this account may create drafts. Test the connection to check again."
              : null;

  return {
    configured: true,
    status: connection.status,
    siteHost: parsed?.ok ? parsed.value.hostname : null,
    baseUrl: connection.baseUrl,
    credentialConfigured: Boolean(connection.credential),
    accountName: connection.externalAccountName,
    lastCheckedAt: connection.lastCheckedAt,
    publishingMode: policy?.mode ?? null,
    capabilities: { readContent, createPost, createPage },
    selectableTargets,
    ready: reason === null,
    reason,
  };
}

/** A person's name for the trail, without exposing anything else about them. */
function nameOf(user: { displayName: string | null; email: string } | null): string | null {
  if (!user) return null;
  return user.displayName ?? user.email;
}

/** The safe part of a verification's stored detail. Never content. */
function detailOf(type: VerificationType, observed: unknown, expected: unknown): string | null {
  if (type === "CMS_STATUS_DRAFT") {
    return typeof observed === "string" ? `WordPress reports: ${observed}` : null;
  }
  if (type === "SLUG_MATCH") {
    const want = typeof expected === "string" ? expected : null;
    const got = typeof observed === "string" ? observed : null;
    return want && got && want !== got ? `Requested ${want}, WordPress used ${got}` : null;
  }
  if (type === "CONTENT_PRESENT" && observed && typeof observed === "object") {
    const difference = (observed as { difference?: { kind?: unknown } }).difference;
    const kind = difference?.kind;
    // The kind of difference and where, never the words themselves.
    return typeof kind === "string" ? `First difference: ${kind.toLowerCase()}` : null;
  }
  return null;
}

/**
 * Every work item that has reached the CMS gate, with whatever happened to it.
 *
 * Includes work approved for the CMS that has never been executed, because
 * "nothing has been sent yet" is the state a person most often arrives to act
 * on. Ordered by most recently touched.
 */
export async function listCmsDrafts(context: TenantContext): Promise<CmsDraftRow[]> {
  const canReview = hasRole(context.membership.role, REQUIRED.REVIEW);
  const readiness = await getCmsConnectionReadiness(context);
  const now = new Date();

  const workItems = await prisma.contentWorkItem.findMany({
    where: {
      ...websiteScope(context),
      OR: [
        { status: { in: ["APPROVED_FOR_CMS", "CMS_DRAFT_CREATED"] } },
        { executions: { some: { executionType: "CREATE_CMS_DRAFT" } } },
      ],
    },
    select: {
      id: true,
      title: true,
      status: true,
      cmsApprovals: {
        where: { status: "APPROVED" },
        orderBy: { approvedAt: "desc" },
        take: 1,
        select: {
          revisionNumber: true,
          revisionHash: true,
          approvedAt: true,
          approvedBy: { select: { displayName: true, email: true } },
        },
      },
      executions: {
        where: { executionType: "CREATE_CMS_DRAFT" },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          connection: { select: { baseUrl: true, authType: true } },
          requestedBy: { select: { displayName: true, email: true } },
          executedBy: { select: { displayName: true, email: true } },
          verifications: { orderBy: { verificationType: "asc" } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return workItems.map((item) => {
    const execution = item.executions[0] ?? null;
    const approval = item.cmsApprovals[0] ?? null;

    const unresolved = execution ? isUnresolved(execution, now) : false;
    const retrySafe = execution ? isRetrySafeFailure(execution.errorCode) : false;
    const state = cmsDraftState(execution, {
      unresolved,
      retrySafe,
      approvedForCms: item.status === "APPROVED_FOR_CMS",
    });

    const parsed = execution?.connection.baseUrl
      ? parseCmsBaseUrl(execution.connection.baseUrl)
      : null;

    // Only the newest attempt's checks: an older attempt's are history, shown
    // on the execution rather than as the current answer.
    const verifications: CmsDraftVerification[] = (execution?.verifications ?? [])
      .filter((row) => row.attempt === execution?.attempt)
      .map((row) => ({
        type: row.verificationType,
        status: row.status,
        required: REQUIRED_VERIFICATIONS.has(row.verificationType),
        detail: detailOf(row.verificationType, row.observedValueJson, row.expectedValueJson),
      }));

    const { nextAction, blockedReason } = decideAction({
      state,
      canReview,
      readiness,
      workItemStatus: item.status,
      hasExternalId: execution?.externalEntityId != null,
    });

    return {
      workItemId: item.id,
      title: item.title,
      revisionNumber: approval?.revisionNumber ?? null,
      revisionHash: approval?.revisionHash ?? execution?.revisionHash ?? null,
      executionId: execution?.id ?? null,
      targetEntityType: execution?.targetEntityType ?? null,
      state,
      externalStatus: execution?.externalStatus ?? null,
      externalEntityId: execution?.externalEntityId ?? null,
      externalUrl: execution?.externalUrl ?? null,
      siteHost: parsed?.ok ? parsed.value.hostname : readiness.siteHost,
      simulated: execution?.connection.authType === "SIMULATED",
      approvedByName: nameOf(approval?.approvedBy ?? null),
      requestedByName: nameOf(execution?.requestedBy ?? null),
      executedByName: nameOf(execution?.executedBy ?? null),
      approvedAt: approval?.approvedAt ?? null,
      startedAt: execution?.startedAt ?? null,
      completedAt: execution?.completedAt ?? null,
      verifiedAt: execution?.verifiedAt ?? null,
      verifications,
      nextAction,
      blockedReason,
    };
  });
}

/**
 * The one act a row is open to, and why it is not open to any.
 *
 * Deliberately conservative and deliberately duplicated by the server: this
 * decides what to draw, and M6.3 decides what may happen. When they disagree
 * the server wins, which is the only arrangement in which a screen cannot be
 * the security boundary.
 */
function decideAction(input: {
  state: CmsDraftState;
  canReview: boolean;
  readiness: CmsConnectionReadiness;
  workItemStatus: string;
  hasExternalId: boolean;
}): { nextAction: CmsDraftAction; blockedReason: string | null } {
  const { state, canReview, readiness, workItemStatus, hasExternalId } = input;

  if (!canReview) {
    return {
      nextAction: "NONE",
      blockedReason:
        "You can view this execution, but you do not have permission to create or reconcile CMS drafts.",
    };
  }

  if (state === "RECONCILIATION_REQUIRED") {
    return { nextAction: "RECONCILE", blockedReason: null };
  }

  // Anything that exists in WordPress may be looked at again, provided the
  // connection can still be read.
  if (hasExternalId) {
    return readiness.configured && readiness.status === "CONNECTED"
      ? { nextAction: "REVERIFY", blockedReason: null }
      : {
          nextAction: "NONE",
          blockedReason:
            "The WordPress connection is unavailable, so this draft cannot be re-checked right now.",
        };
  }

  if (state === "CREATING") {
    return { nextAction: "NONE", blockedReason: "A draft is being created now." };
  }

  const executable = state === "READY" || state === "RETRY_PERMITTED" || state === "NONE";
  if (!executable) return { nextAction: "NONE", blockedReason: null };

  if (workItemStatus !== "APPROVED_FOR_CMS") {
    return {
      nextAction: "NONE",
      blockedReason:
        "This work is not currently approved for the CMS. Fresh QA and a CMS approval are needed before it can be executed.",
    };
  }

  if (!readiness.ready) {
    return { nextAction: "NONE", blockedReason: readiness.reason };
  }

  return { nextAction: "CREATE", blockedReason: null };
}

/** Counts for the Command Center (M6.4 §30). */
export type CmsDraftCounts = {
  readyToCreate: number;
  needsReconciliation: number;
  verificationFailed: number;
  verified: number;
};

export async function getCmsDraftCounts(context: TenantContext): Promise<CmsDraftCounts> {
  const rows = await listCmsDrafts(context);

  return {
    readyToCreate: rows.filter((row) => row.nextAction === "CREATE").length,
    needsReconciliation: rows.filter((row) => row.state === "RECONCILIATION_REQUIRED").length,
    verificationFailed: rows.filter((row) => row.state === "VERIFICATION_FAILED").length,
    verified: rows.filter((row) => row.state === "VERIFIED").length,
  };
}
