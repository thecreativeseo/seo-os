-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('PAGE_DIAGNOSIS');

-- CreateEnum
CREATE TYPE "AiTaskType" AS ENUM ('DIAGNOSE_PAGE');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PromptStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "EvidenceCategory" AS ENUM ('BUSINESS_CONTEXT', 'BUSINESS_GOAL', 'BRAND_FACT', 'SEO_RULE', 'GSC_METRIC', 'GA4_METRIC', 'KEYWORD_METRIC', 'RANKING_SNAPSHOT', 'KEYWORD_OWNERSHIP', 'TOPIC_MAPPING', 'COMPETITOR_OBSERVATION', 'PAGE_CONTENT', 'INTERNAL_LINK', 'TECHNICAL_FINDING', 'PREVIOUS_CHANGE', 'PREVIOUS_DIAGNOSIS', 'PREVIOUS_LEARNING', 'MANUAL_VERIFICATION');

-- CreateEnum
CREATE TYPE "EvidenceReliability" AS ENUM ('DIRECT_FIRST_PARTY', 'DIRECT_PROVIDER', 'USER_PROVIDED', 'SYSTEM_DERIVED', 'AI_INFERRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DiagnosisRequestStatus" AS ENUM ('REQUESTED', 'ASSEMBLING_EVIDENCE', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiagnosisStatus" AS ENUM ('DRAFT', 'AWAITING_REVIEW', 'REVIEWED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DiagnosticCategory" AS ENUM ('INTENT_MISMATCH', 'CTR_SERP_MISMATCH', 'KEYWORD_OWNERSHIP_CONFLICT', 'CANNIBALIZATION', 'CONTENT_GAP', 'CONTENT_STALENESS', 'WEAK_INTERNAL_SUPPORT', 'COMPETITOR_DISPLACEMENT', 'TECHNICAL_INDEXATION', 'TECHNICAL_RENDERING', 'TECHNICAL_CANONICALIZATION', 'SERP_FEATURE_CHANGE', 'SEASONALITY', 'CONVERSION_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "FindingVerdict" AS ENUM ('CONFIRMED', 'STRONGLY_SUPPORTED', 'SUSPECT', 'CLEAR', 'UNKNOWN', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "EvidenceRelationship" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'CONTEXT');

-- CreateEnum
CREATE TYPE "RecommendationType" AS ENUM ('CONTENT_REFRESH', 'CONTENT_CREATE', 'TITLE_META_UPDATE', 'INTENT_REALIGNMENT', 'KEYWORD_OWNERSHIP_FIX', 'INTERNAL_LINK_UPDATE', 'PAGE_CONSOLIDATION', 'PAGE_SPLIT', 'TECHNICAL_INVESTIGATION', 'TECHNICAL_FIX', 'SERP_REVIEW', 'CONVERSION_REVIEW', 'MONITOR_ONLY', 'REQUEST_MORE_EVIDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('DRAFT', 'AWAITING_REVIEW', 'APPROVED', 'MODIFIED', 'REJECTED', 'NEEDS_EVIDENCE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DecisionValue" AS ENUM ('APPROVED', 'MODIFIED', 'REJECTED', 'NEEDS_EVIDENCE');

-- CreateEnum
CREATE TYPE "ContentSource" AS ENUM ('MANUAL_PASTE', 'UPLOAD', 'FETCH');

-- DropForeignKey
ALTER TABLE "keyword" DROP CONSTRAINT "keyword_business_goal_id_fkey";

-- DropForeignKey
ALTER TABLE "topic" DROP CONSTRAINT "topic_business_goal_id_fkey";

-- DropIndex
DROP INDEX "keyword_business_goal_id_idx";

-- DropIndex
DROP INDEX "opportunity_identity_key";

-- DropIndex
DROP INDEX "topic_business_goal_id_idx";

-- CreateTable
CREATE TABLE "prompt_template" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "agent_type" "AgentType" NOT NULL,
    "task_type" "AiTaskType" NOT NULL,
    "version" INTEGER NOT NULL,
    "system_instructions" TEXT NOT NULL,
    "output_schema_version" TEXT NOT NULL,
    "status" "PromptStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "prompt_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_run" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "agent_type" "AgentType" NOT NULL,
    "task_type" "AiTaskType" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_template_id" UUID,
    "prompt_template_version" INTEGER,
    "output_schema_version" TEXT NOT NULL,
    "evidence_package_id" UUID,
    "status" "AiRunStatus" NOT NULL DEFAULT 'QUEUED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "estimated_cost" DECIMAL(12,6),
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retrieval_policy" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT,
    "policy_json" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retrieval_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_package" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "assembled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "context_version_id" UUID,
    "period_start" DATE,
    "period_end" DATE,
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "retrieval_policy_id" UUID,
    "retrieval_policy_version" INTEGER,
    "retrieval_manifest_json" JSONB,
    "content_hash" TEXT NOT NULL,
    "sealed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_ref" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "evidence_type" "EvidenceCategory" NOT NULL,
    "reliability" "EvidenceReliability" NOT NULL,
    "source_entity_type" TEXT NOT NULL,
    "source_entity_id" TEXT,
    "captured_at" TIMESTAMP(3),
    "as_of_date" DATE,
    "metric_key" TEXT,
    "numeric_value" DECIMAL(18,4),
    "text_value" TEXT,
    "context_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_request" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "signal_id" UUID,
    "opportunity_id" UUID,
    "requested_by_user_id" UUID,
    "status" "DiagnosisRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "evidence_package_id" UUID,
    "ai_run_id" UUID,
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "diagnosis_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "request_id" UUID,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "signal_id" UUID,
    "opportunity_id" UUID,
    "status" "DiagnosisStatus" NOT NULL DEFAULT 'DRAFT',
    "executive_summary" TEXT NOT NULL,
    "primary_finding_id" UUID,
    "overall_confidence" "ConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
    "evidence_package_id" UUID,
    "ai_run_id" UUID,
    "supersedes_id" UUID,
    "created_by_user_id" UUID,
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_finding" (
    "id" UUID NOT NULL,
    "diagnosis_id" UUID NOT NULL,
    "category" "DiagnosticCategory" NOT NULL,
    "verdict" "FindingVerdict" NOT NULL,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "supporting_evidence_count" INTEGER NOT NULL DEFAULT 0,
    "contradicting_evidence_count" INTEGER NOT NULL DEFAULT 0,
    "missing_evidence_json" JSONB,
    "downgraded_from" "FindingVerdict",
    "downgrade_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_finding_evidence" (
    "id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "relationship" "EvidenceRelationship" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_finding_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "diagnosis_id" UUID,
    "opportunity_id" UUID,
    "type" "RecommendationType" NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'AWAITING_REVIEW',
    "priority" "OpportunityPriority" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "page_id" UUID,
    "keyword_id" UUID,
    "topic_id" UUID,
    "expected_effect_description" TEXT,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
    "effort" "EffortLevel" NOT NULL DEFAULT 'UNKNOWN',
    "risk" "RiskLevel" NOT NULL DEFAULT 'UNKNOWN',
    "blocked_by_rule_id" UUID,
    "blocked_reason" TEXT,
    "owner_user_id" UUID,
    "created_by_ai_run_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "implemented_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_evidence" (
    "id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "decision" "DecisionValue" NOT NULL,
    "reason" TEXT,
    "modified_recommendation_json" JSONB,
    "overridden_rule_id" UUID,
    "override_reason" TEXT,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_content_snapshot" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content_hash" TEXT NOT NULL,
    "title" TEXT,
    "meta_description" TEXT,
    "headings_json" JSONB,
    "body_text" TEXT,
    "word_count" INTEGER,
    "source" "ContentSource" NOT NULL,
    "object_storage_key" TEXT,
    "captured_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_content_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompt_template_agent_type_task_type_status_idx" ON "prompt_template"("agent_type", "task_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_template_agent_type_task_type_version_key" ON "prompt_template"("agent_type", "task_type", "version");

-- CreateIndex
CREATE INDEX "ai_run_website_id_created_at_idx" ON "ai_run"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_run_status_idx" ON "ai_run"("status");

-- CreateIndex
CREATE UNIQUE INDEX "retrieval_policy_name_version_key" ON "retrieval_policy"("name", "version");

-- CreateIndex
CREATE INDEX "evidence_package_website_id_assembled_at_idx" ON "evidence_package"("website_id", "assembled_at");

-- CreateIndex
CREATE INDEX "evidence_package_website_id_target_type_target_id_idx" ON "evidence_package"("website_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "evidence_ref_package_id_evidence_type_idx" ON "evidence_ref"("package_id", "evidence_type");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_ref_package_id_evidence_id_key" ON "evidence_ref"("package_id", "evidence_id");

-- CreateIndex
CREATE INDEX "diagnosis_request_website_id_created_at_idx" ON "diagnosis_request"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "diagnosis_request_website_id_status_idx" ON "diagnosis_request"("website_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "diagnosis_supersedes_id_key" ON "diagnosis"("supersedes_id");

-- CreateIndex
CREATE INDEX "diagnosis_website_id_created_at_idx" ON "diagnosis"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "diagnosis_website_id_target_type_target_id_idx" ON "diagnosis"("website_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "diagnosis_finding_diagnosis_id_idx" ON "diagnosis_finding"("diagnosis_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnosis_finding_diagnosis_id_category_key" ON "diagnosis_finding"("diagnosis_id", "category");

-- CreateIndex
CREATE INDEX "diagnosis_finding_evidence_finding_id_idx" ON "diagnosis_finding_evidence"("finding_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnosis_finding_evidence_finding_id_evidence_id_relations_key" ON "diagnosis_finding_evidence"("finding_id", "evidence_id", "relationship");

-- CreateIndex
CREATE INDEX "recommendation_website_id_status_idx" ON "recommendation"("website_id", "status");

-- CreateIndex
CREATE INDEX "recommendation_diagnosis_id_idx" ON "recommendation"("diagnosis_id");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_evidence_recommendation_id_evidence_id_key" ON "recommendation_evidence"("recommendation_id", "evidence_id");

-- CreateIndex
CREATE INDEX "decision_website_id_decided_at_idx" ON "decision"("website_id", "decided_at");

-- CreateIndex
CREATE INDEX "decision_recommendation_id_idx" ON "decision"("recommendation_id");

-- CreateIndex
CREATE INDEX "page_content_snapshot_website_id_captured_at_idx" ON "page_content_snapshot"("website_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "page_content_snapshot_page_id_content_hash_key" ON "page_content_snapshot"("page_id", "content_hash");

-- AddForeignKey
ALTER TABLE "keyword" ADD CONSTRAINT "keyword_business_goal_id_fkey" FOREIGN KEY ("business_goal_id") REFERENCES "business_goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_business_goal_id_fkey" FOREIGN KEY ("business_goal_id") REFERENCES "business_goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_prompt_template_id_fkey" FOREIGN KEY ("prompt_template_id") REFERENCES "prompt_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "evidence_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_package" ADD CONSTRAINT "evidence_package_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_package" ADD CONSTRAINT "evidence_package_context_version_id_fkey" FOREIGN KEY ("context_version_id") REFERENCES "business_context_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_package" ADD CONSTRAINT "evidence_package_retrieval_policy_id_fkey" FOREIGN KEY ("retrieval_policy_id") REFERENCES "retrieval_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_ref" ADD CONSTRAINT "evidence_ref_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "evidence_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_request" ADD CONSTRAINT "diagnosis_request_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_request" ADD CONSTRAINT "diagnosis_request_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_request" ADD CONSTRAINT "diagnosis_request_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_request" ADD CONSTRAINT "diagnosis_request_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_request" ADD CONSTRAINT "diagnosis_request_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "evidence_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_request" ADD CONSTRAINT "diagnosis_request_ai_run_id_fkey" FOREIGN KEY ("ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "diagnosis_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "evidence_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_ai_run_id_fkey" FOREIGN KEY ("ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "diagnosis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_finding" ADD CONSTRAINT "diagnosis_finding_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnosis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_finding_evidence" ADD CONSTRAINT "diagnosis_finding_evidence_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "diagnosis_finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnosis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_blocked_by_rule_id_fkey" FOREIGN KEY ("blocked_by_rule_id") REFERENCES "seo_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_created_by_ai_run_id_fkey" FOREIGN KEY ("created_by_ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_evidence" ADD CONSTRAINT "recommendation_evidence_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_overridden_rule_id_fkey" FOREIGN KEY ("overridden_rule_id") REFERENCES "seo_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_content_snapshot" ADD CONSTRAINT "page_content_snapshot_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_content_snapshot" ADD CONSTRAINT "page_content_snapshot_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_content_snapshot" ADD CONSTRAINT "page_content_snapshot_captured_by_user_id_fkey" FOREIGN KEY ("captured_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
