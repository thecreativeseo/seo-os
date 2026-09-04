-- P4 M1: the execution schema (docs/P4_SPEC.md sections 6-27, 34).
--
-- Generated from the schema, then extended by hand with what Prisma cannot
-- express: partial unique indexes, the revision provenance check, and the
-- history-preserving triggers. Purely additive: no existing row changes meaning.

-- CreateEnum
CREATE TYPE "ContentWorkItemType" AS ENUM ('NEW_CONTENT', 'CONTENT_REFRESH', 'TITLE_META_UPDATE', 'INTENT_REALIGNMENT', 'KEYWORD_OWNERSHIP_FIX', 'INTERNAL_LINK_UPDATE', 'PAGE_CONSOLIDATION_PREP', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentWorkItemStatus" AS ENUM ('QUEUED', 'BRIEFING', 'DRAFTING', 'QA', 'AWAITING_EDITOR_REVIEW', 'APPROVED_FOR_CMS', 'CMS_DRAFT_CREATED', 'AWAITING_PUBLISH_APPROVAL', 'PUBLISHING', 'PUBLISHED', 'VERIFYING', 'VERIFIED', 'FAILED', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentBriefStatus" AS ENUM ('DRAFT', 'AWAITING_REVIEW', 'APPROVED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentDraftStatus" AS ENUM ('DRAFTING', 'AWAITING_QA', 'AWAITING_EDITOR_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentQaType" AS ENUM ('BRAND_FACT_VALIDATION', 'SEO_RULE_VALIDATION', 'ON_PAGE_SEO', 'INTENT_ALIGNMENT', 'ANSWER_READINESS', 'INTERNAL_LINKING', 'CLAIM_SAFETY', 'STRUCTURE', 'READABILITY', 'DUPLICATION_RISK');

-- CreateEnum
CREATE TYPE "ContentQaStatus" AS ENUM ('PASS', 'PASS_WITH_WARNINGS', 'FAIL');

-- CreateEnum
CREATE TYPE "InternalLinkSuggestionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'IMPLEMENTED');

-- CreateEnum
CREATE TYPE "CmsAuthType" AS ENUM ('APPLICATION_PASSWORD', 'OAUTH2', 'CUSTOM_PLUGIN_TOKEN', 'SIMULATED');

-- CreateEnum
CREATE TYPE "PublishingMode" AS ENUM ('READ_ONLY', 'DRAFT_ONLY', 'DRAFT_AND_UPDATE', 'PUBLISH_WITH_APPROVAL', 'FULL_PUBLISH');

-- CreateEnum
CREATE TYPE "ExecutionType" AS ENUM ('CREATE_CMS_DRAFT', 'UPDATE_CMS_DRAFT', 'PUBLISH_CONTENT', 'UPDATE_PUBLISHED_CONTENT', 'APPLY_INTERNAL_LINK_UPDATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PROPOSED', 'READY', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'VERIFYING', 'VERIFIED', 'FAILED', 'CANCELLED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ExecutionStepType" AS ENUM ('PREFLIGHT', 'TEST_CONNECTION', 'CREATE_DRAFT', 'UPDATE_DRAFT', 'GET_PREVIEW', 'PUBLISH', 'GET_PUBLISHED_PAGE', 'VERIFY_STATE', 'RECONCILE');

-- CreateEnum
CREATE TYPE "ExecutionStepStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PublishApprovalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('URL_RESOLVES', 'HTTP_STATUS', 'TITLE_MATCH', 'META_DESCRIPTION_MATCH', 'H1_MATCH', 'CONTENT_PRESENT', 'CANONICAL_PRESENT', 'INTERNAL_LINK_PRESENT', 'CMS_STATUS_PUBLISHED');

-- CreateEnum
CREATE TYPE "ExecutionVerificationStatus" AS ENUM ('PASS', 'FAIL', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CmsSandboxPostStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentType" ADD VALUE 'CONTENT_BRIEF';
ALTER TYPE "AgentType" ADD VALUE 'CONTENT_DRAFT';
ALTER TYPE "AgentType" ADD VALUE 'CONTENT_QA';
ALTER TYPE "AgentType" ADD VALUE 'INTERNAL_LINK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiTaskType" ADD VALUE 'GENERATE_BRIEF';
ALTER TYPE "AiTaskType" ADD VALUE 'GENERATE_DRAFT';
ALTER TYPE "AiTaskType" ADD VALUE 'REVISE_DRAFT';
ALTER TYPE "AiTaskType" ADD VALUE 'QA_CONTENT';
ALTER TYPE "AiTaskType" ADD VALUE 'SUGGEST_INTERNAL_LINKS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'REQUEST_APPROVAL';
ALTER TYPE "AuditAction" ADD VALUE 'EXECUTE';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLISH';
ALTER TYPE "AuditAction" ADD VALUE 'VERIFY';
ALTER TYPE "AuditAction" ADD VALUE 'SUPERSEDE';
ALTER TYPE "AuditAction" ADD VALUE 'CONNECT';

-- AlterEnum
ALTER TYPE "RecommendationStatus" ADD VALUE 'IMPLEMENTED';

-- AlterTable
ALTER TABLE "seo_rule" ADD COLUMN     "check_json" JSONB;

-- CreateTable
CREATE TABLE "content_work_item" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "type" "ContentWorkItemType" NOT NULL,
    "status" "ContentWorkItemStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" "OpportunityPriority" NOT NULL DEFAULT 'MEDIUM',
    "page_id" UUID,
    "keyword_id" UUID,
    "topic_id" UUID,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "owner_user_id" UUID,
    "rule_overrides_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "content_work_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_brief" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "target_page_id" UUID,
    "primary_keyword_id" UUID,
    "secondary_keyword_ids_json" JSONB,
    "topic_id" UUID,
    "search_intent" "KeywordIntent",
    "business_goal_id" UUID,
    "primary_conversion" TEXT,
    "audience" TEXT,
    "customer_problem" TEXT,
    "desired_outcome" TEXT,
    "recommended_angle" TEXT,
    "key_questions_json" JSONB,
    "required_sections_json" JSONB,
    "optional_sections_json" JSONB,
    "internal_link_targets_json" JSONB,
    "external_evidence_requirements_json" JSONB,
    "approved_claims_json" JSONB,
    "prohibited_claims_json" JSONB,
    "brand_voice_notes" TEXT,
    "seo_rule_constraints_json" JSONB,
    "status" "ContentBriefStatus" NOT NULL DEFAULT 'DRAFT',
    "evidence_package_id" UUID,
    "created_by_ai_run_id" UUID,
    "created_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "content_brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_draft" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "brief_id" UUID NOT NULL,
    "current_revision_id" UUID,
    "approved_revision_id" UUID,
    "approved_revision_hash" TEXT,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMP(3),
    "status" "ContentDraftStatus" NOT NULL DEFAULT 'DRAFTING',
    "created_by_ai_run_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "content_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_revision" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_draft_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "excerpt" TEXT,
    "body_markdown" TEXT NOT NULL,
    "body_html" TEXT,
    "meta_title" TEXT,
    "meta_description" TEXT,
    "schema_json" JSONB,
    "change_summary" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "evidence_package_id" UUID,
    "created_by_ai_run_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_qa_result" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_revision_id" UUID NOT NULL,
    "qa_type" "ContentQaType" NOT NULL,
    "status" "ContentQaStatus" NOT NULL,
    "score" INTEGER,
    "issues_json" JSONB NOT NULL DEFAULT '[]',
    "warnings_json" JSONB NOT NULL DEFAULT '[]',
    "blocking_issues_json" JSONB NOT NULL DEFAULT '[]',
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checker_version" TEXT NOT NULL,
    "ai_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_qa_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_link_suggestion" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "source_page_id" UUID,
    "target_page_id" UUID NOT NULL,
    "anchor_text" TEXT NOT NULL,
    "placement_context" TEXT,
    "reason" TEXT,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
    "status" "InternalLinkSuggestionStatus" NOT NULL DEFAULT 'PROPOSED',
    "created_by_ai_run_id" UUID,
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "internal_link_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_policy" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "mode" "PublishingMode" NOT NULL DEFAULT 'DRAFT_ONLY',
    "require_editor_approval" BOOLEAN NOT NULL DEFAULT true,
    "require_publish_approval" BOOLEAN NOT NULL DEFAULT true,
    "require_qa_pass" BOOLEAN NOT NULL DEFAULT true,
    "require_distinct_approver" BOOLEAN NOT NULL DEFAULT false,
    "allowed_content_types_json" JSONB,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "content_revision_id" UUID NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "execution_type" "ExecutionType" NOT NULL,
    "provider" "ConnectionProvider" NOT NULL,
    "connection_id" UUID NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PROPOSED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "requested_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "executed_by_user_id" UUID,
    "external_entity_id" TEXT,
    "external_url" TEXT,
    "before_snapshot_json" JSONB,
    "after_snapshot_json" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_step" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "step_type" "ExecutionStepType" NOT NULL,
    "status" "ExecutionStepStatus" NOT NULL,
    "request_summary_json" JSONB,
    "response_summary_json" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_approval" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "content_revision_id" UUID NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "status" "PublishApprovalStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_user_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_verification" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "verification_type" "VerificationType" NOT NULL,
    "status" "ExecutionVerificationStatus" NOT NULL,
    "expected_value_json" JSONB,
    "observed_value_json" JSONB,
    "verified_at" TIMESTAMP(3),
    "error_summary" TEXT,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolution_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cms_sandbox_post" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "status" "CmsSandboxPostStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content_html" TEXT NOT NULL,
    "meta_description" TEXT,
    "served_title" TEXT,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "cms_sandbox_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_work_item_website_id_status_idx" ON "content_work_item"("website_id", "status");

-- CreateIndex
CREATE INDEX "content_work_item_website_id_created_at_idx" ON "content_work_item"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "content_work_item_recommendation_id_idx" ON "content_work_item"("recommendation_id");

-- CreateIndex
CREATE INDEX "content_brief_website_id_status_idx" ON "content_brief"("website_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_brief_content_work_item_id_version_key" ON "content_brief"("content_work_item_id", "version");

-- CreateIndex
CREATE INDEX "content_draft_website_id_status_idx" ON "content_draft"("website_id", "status");

-- CreateIndex
CREATE INDEX "content_draft_content_work_item_id_idx" ON "content_draft"("content_work_item_id");

-- CreateIndex
CREATE INDEX "content_revision_website_id_created_at_idx" ON "content_revision"("website_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_revision_content_draft_id_revision_number_key" ON "content_revision"("content_draft_id", "revision_number");

-- CreateIndex
CREATE INDEX "content_qa_result_content_revision_id_qa_type_checked_at_idx" ON "content_qa_result"("content_revision_id", "qa_type", "checked_at");

-- CreateIndex
CREATE INDEX "content_qa_result_website_id_status_idx" ON "content_qa_result"("website_id", "status");

-- CreateIndex
CREATE INDEX "internal_link_suggestion_website_id_status_idx" ON "internal_link_suggestion"("website_id", "status");

-- CreateIndex
CREATE INDEX "internal_link_suggestion_content_work_item_id_idx" ON "internal_link_suggestion"("content_work_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_policy_website_id_connection_id_key" ON "publishing_policy"("website_id", "connection_id");

-- CreateIndex
CREATE INDEX "execution_website_id_status_idx" ON "execution"("website_id", "status");

-- CreateIndex
CREATE INDEX "execution_content_work_item_id_execution_type_idx" ON "execution"("content_work_item_id", "execution_type");

-- CreateIndex
CREATE INDEX "execution_step_execution_id_started_at_idx" ON "execution_step"("execution_id", "started_at");

-- CreateIndex
CREATE INDEX "publish_approval_website_id_status_idx" ON "publish_approval"("website_id", "status");

-- CreateIndex
CREATE INDEX "publish_approval_execution_id_idx" ON "publish_approval"("execution_id");

-- CreateIndex
CREATE INDEX "execution_verification_execution_id_attempt_idx" ON "execution_verification"("execution_id", "attempt");

-- CreateIndex
CREATE INDEX "execution_verification_website_id_status_idx" ON "execution_verification"("website_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cms_sandbox_post_website_id_external_id_key" ON "cms_sandbox_post"("website_id", "external_id");

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_work_item" ADD CONSTRAINT "content_work_item_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_target_page_id_fkey" FOREIGN KEY ("target_page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_primary_keyword_id_fkey" FOREIGN KEY ("primary_keyword_id") REFERENCES "keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_business_goal_id_fkey" FOREIGN KEY ("business_goal_id") REFERENCES "business_goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "evidence_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_created_by_ai_run_id_fkey" FOREIGN KEY ("created_by_ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "content_brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "content_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_approved_revision_id_fkey" FOREIGN KEY ("approved_revision_id") REFERENCES "content_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_created_by_ai_run_id_fkey" FOREIGN KEY ("created_by_ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_content_draft_id_fkey" FOREIGN KEY ("content_draft_id") REFERENCES "content_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "evidence_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_created_by_ai_run_id_fkey" FOREIGN KEY ("created_by_ai_run_id") REFERENCES "ai_run"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_result" ADD CONSTRAINT "content_qa_result_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_result" ADD CONSTRAINT "content_qa_result_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "content_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_result" ADD CONSTRAINT "content_qa_result_ai_run_id_fkey" FOREIGN KEY ("ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_link_suggestion" ADD CONSTRAINT "internal_link_suggestion_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_link_suggestion" ADD CONSTRAINT "internal_link_suggestion_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_link_suggestion" ADD CONSTRAINT "internal_link_suggestion_source_page_id_fkey" FOREIGN KEY ("source_page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_link_suggestion" ADD CONSTRAINT "internal_link_suggestion_target_page_id_fkey" FOREIGN KEY ("target_page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_link_suggestion" ADD CONSTRAINT "internal_link_suggestion_created_by_ai_run_id_fkey" FOREIGN KEY ("created_by_ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_link_suggestion" ADD CONSTRAINT "internal_link_suggestion_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_policy" ADD CONSTRAINT "publishing_policy_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_policy" ADD CONSTRAINT "publishing_policy_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_policy" ADD CONSTRAINT "publishing_policy_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_policy" ADD CONSTRAINT "publishing_policy_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "content_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_executed_by_user_id_fkey" FOREIGN KEY ("executed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_step" ADD CONSTRAINT "execution_step_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_step" ADD CONSTRAINT "execution_step_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "content_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_verification" ADD CONSTRAINT "execution_verification_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_verification" ADD CONSTRAINT "execution_verification_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_verification" ADD CONSTRAINT "execution_verification_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cms_sandbox_post" ADD CONSTRAINT "cms_sandbox_post_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- P4 integrity the Prisma schema cannot express
-- (docs/P4_SPEC.md §7, §10, §22, §25; the P4 plan, section 2)
-- ---------------------------------------------------------------------------

-- One open work item per recommendation.
CREATE UNIQUE INDEX "content_work_item_open_per_recommendation"
  ON "content_work_item" ("recommendation_id")
  WHERE "status" NOT IN ('CANCELLED', 'ARCHIVED');

-- One active execution per (work item, type). Finished ones - succeeded,
-- verifying, verified, failed, cancelled - release the slot.
CREATE UNIQUE INDEX "execution_active_per_item_type"
  ON "execution" ("content_work_item_id", "execution_type")
  WHERE "status" IN ('PROPOSED', 'READY', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING');

-- One open approval per execution.
CREATE UNIQUE INDEX "publish_approval_requested_per_execution"
  ON "publish_approval" ("execution_id")
  WHERE "status" = 'REQUESTED';

-- A revision has exactly one author: a run or a person, never both, never neither.
ALTER TABLE "content_revision"
  ADD CONSTRAINT "content_revision_provenance_check"
  CHECK (("created_by_ai_run_id" IS NULL) <> ("created_by_user_id" IS NULL));

-- History-preserving rows below refuse DELETE unless the session has said,
-- deliberately and for the current transaction only, that it is tearing
-- history down (a test tenant, an organization being removed):
--
--   SET LOCAL seo_os.allow_history_delete = 'on';
--
-- The application never sets it. UPDATE is refused regardless.
CREATE OR REPLACE FUNCTION seo_os_history_delete_allowed()
RETURNS boolean AS $$
  SELECT COALESCE(current_setting('seo_os.allow_history_delete', true), 'off') = 'on';
$$ LANGUAGE sql STABLE;

-- An approved brief version is immutable. The one change it may take is being
-- superseded or archived, with every other column exactly as it was.
CREATE OR REPLACE FUNCTION enforce_content_brief_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'APPROVED' AND NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION
        'content_brief % is APPROVED and immutable (attempted DELETE)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'APPROVED' THEN
    IF NEW.status NOT IN ('SUPERSEDED', 'ARCHIVED')
       OR (to_jsonb(NEW) - 'status' - 'archived_at') <> (to_jsonb(OLD) - 'status' - 'archived_at') THEN
      RAISE EXCEPTION
        'content_brief % is APPROVED and immutable (attempted UPDATE)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_brief_approved_immutable
  BEFORE UPDATE OR DELETE ON "content_brief"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_brief_immutability();

-- A revision is written once.
CREATE OR REPLACE FUNCTION enforce_content_revision_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION
        'content_revision % is immutable (attempted DELETE)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'content_revision % is immutable (attempted UPDATE)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_revision_immutable
  BEFORE UPDATE OR DELETE ON "content_revision"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_revision_immutability();

-- A decided approval never changes again.
CREATE OR REPLACE FUNCTION enforce_publish_approval_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION
        'publish_approval % is history (attempted DELETE)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION
      'publish_approval % is % and immutable (attempted UPDATE)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER publish_approval_decided_immutable
  BEFORE UPDATE OR DELETE ON "publish_approval"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_publish_approval_immutability();

-- Execution steps are appended, never edited.
CREATE OR REPLACE FUNCTION enforce_execution_step_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION
        'execution_step % is history (attempted DELETE)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'execution_step % is append-only (attempted UPDATE)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_step_append_only
  BEFORE UPDATE OR DELETE ON "execution_step"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_execution_step_append_only();
