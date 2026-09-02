-- CreateEnum
CREATE TYPE "KeywordIntent" AS ENUM ('INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL', 'LOCAL', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IntentProvenance" AS ENUM ('USER_PROVIDED', 'PROVIDER_PROVIDED', 'SYSTEM_CLASSIFIED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('PRIMARY', 'SECONDARY', 'EXPERIMENTAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OwnershipStatus" AS ENUM ('ACTIVE', 'REVIEW_NEEDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "OwnershipCandidateType" AS ENUM ('NO_OWNING_PAGE', 'RANKING_URL_DIVERGENCE', 'RANKING_URL_SWITCH', 'MULTIPLE_RANKING_PAGES', 'CANNIBALIZATION_CANDIDATE');

-- CreateEnum
CREATE TYPE "TopicCoverage" AS ENUM ('UNMAPPED', 'PLANNED', 'PARTIAL', 'COVERED', 'OVERLAPPING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TopicAuthority" AS ENUM ('WEAK', 'DEVELOPING', 'STRONG', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TopicPageRole" AS ENUM ('PILLAR', 'SUPPORTING', 'COMMERCIAL', 'UTILITY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('COMMERCIAL_RANKING', 'KEYWORD_OWNERSHIP', 'CTR', 'TOPIC_GAP', 'COMPETITOR_GAP', 'CONTENT_REFRESH', 'NO_OWNING_PAGE', 'KEYWORD_GAP', 'WEAK_OWNING_PAGE', 'RANKING_URL_DIVERGENCE');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('IDENTIFIED', 'QUALIFIED', 'SCHEDULED', 'IN_PROGRESS', 'DECLINED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OpportunityPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EffortLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PARSING', 'VALIDATED', 'PREVIEWED', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('SEMRUSH_POSITIONS', 'SEMRUSH_KEYWORD_OVERVIEW', 'SEMRUSH_COMPETITORS', 'MANUAL_CSV');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'QUALIFY';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE';
ALTER TYPE "AuditAction" ADD VALUE 'DECLINE';
ALTER TYPE "AuditAction" ADD VALUE 'ASSIGN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EvidenceType" ADD VALUE 'RANKING_OBSERVATION';
ALTER TYPE "EvidenceType" ADD VALUE 'KEYWORD_METRIC';
ALTER TYPE "EvidenceType" ADD VALUE 'OWNERSHIP_STATE';
ALTER TYPE "EvidenceType" ADD VALUE 'COMPETITOR_OVERLAP';
ALTER TYPE "EvidenceType" ADD VALUE 'GOAL_ALIGNMENT';

-- DropIndex
DROP INDEX "signal_identity_key";

-- CreateTable
CREATE TABLE "keyword" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "keyword" TEXT NOT NULL,
    "normalized_keyword" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-PH',
    "language" TEXT NOT NULL DEFAULT 'en',
    "market" TEXT NOT NULL DEFAULT 'PH',
    "intent" "KeywordIntent" NOT NULL DEFAULT 'UNKNOWN',
    "intent_provenance" "IntentProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "business_relevance" INTEGER,
    "commercial_value" INTEGER,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_metrics_snapshot" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "captured_at" DATE NOT NULL,
    "search_volume" INTEGER,
    "keyword_difficulty" DECIMAL(6,2),
    "cpc" DECIMAL(12,4),
    "currency" TEXT,
    "source_provider" "ConnectionProvider" NOT NULL,
    "source_connection_id" UUID,
    "source_snapshot_id" UUID,
    "source_import_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keyword_metrics_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranking_snapshot" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "page_id" UUID,
    "captured_at" DATE NOT NULL,
    "position" DECIMAL(7,2),
    "previous_position" DECIMAL(7,2),
    "ranking_url" TEXT,
    "ranking_type" TEXT,
    "serp_features_json" JSONB,
    "source_provider" "ConnectionProvider" NOT NULL,
    "source_connection_id" UUID,
    "source_snapshot_id" UUID,
    "source_import_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_page_ownership" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "ownership_type" "OwnershipType" NOT NULL DEFAULT 'PRIMARY',
    "status" "OwnershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "market" TEXT NOT NULL DEFAULT 'PH',
    "language" TEXT NOT NULL DEFAULT 'en',
    "locale" TEXT NOT NULL DEFAULT 'en-PH',
    "assigned_by_user_id" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "keyword_page_ownership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "customer_language" TEXT,
    "business_outcome" TEXT,
    "parent_topic_id" UUID,
    "pillar_page_id" UUID,
    "commercial_destination_page_id" UUID,
    "coverage_status" "TopicCoverage" NOT NULL DEFAULT 'UNKNOWN',
    "authority_status" "TopicAuthority" NOT NULL DEFAULT 'UNKNOWN',
    "owner_user_id" UUID,
    "priority" INTEGER,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_keyword" (
    "id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_page" (
    "id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "role" "TopicPageRole" NOT NULL DEFAULT 'UNKNOWN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_keyword_snapshot" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "competitor_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "captured_at" DATE NOT NULL,
    "position" DECIMAL(7,2),
    "ranking_url" TEXT,
    "source_provider" "ConnectionProvider" NOT NULL,
    "source_snapshot_id" UUID,
    "source_import_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_keyword_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "source" "ImportSource" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "file_name" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "valid_row_count" INTEGER NOT NULL DEFAULT 0,
    "invalid_row_count" INTEGER NOT NULL DEFAULT 0,
    "committed_row_count" INTEGER NOT NULL DEFAULT 0,
    "raw_content" TEXT,
    "object_storage_key" TEXT,
    "captured_at" DATE,
    "uploaded_by_user_id" UUID,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_json" JSONB NOT NULL,
    "is_valid" BOOLEAN NOT NULL DEFAULT false,
    "error_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "type" "OpportunityType" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'IDENTIFIED',
    "priority" "OpportunityPriority" NOT NULL DEFAULT 'LOW',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "page_id" UUID,
    "keyword_id" UUID,
    "topic_id" UUID,
    "competitor_id" UUID,
    "business_goal_id" UUID,
    "source_signal_id" UUID,
    "effort" "EffortLevel" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'UNKNOWN',
    "business_importance" INTEGER,
    "expected_effect_description" TEXT,
    "score" DECIMAL(6,2),
    "score_inputs_json" JSONB,
    "scoring_model_version" TEXT NOT NULL DEFAULT 'opportunity-scoring-v1',
    "owner_user_id" UUID,
    "identified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualified_at" TIMESTAMP(3),
    "scheduled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_evidence" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "evidence_type" "EvidenceType" NOT NULL,
    "source_entity_type" TEXT NOT NULL,
    "source_entity_id" TEXT NOT NULL,
    "metric_key" TEXT NOT NULL,
    "numeric_value" DECIMAL(18,4),
    "text_value" TEXT,
    "captured_at" TIMESTAMP(3),
    "period_start" DATE,
    "period_end" DATE,
    "source_provider" "ConnectionProvider",
    "source_snapshot_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "keyword_website_id_last_seen_at_idx" ON "keyword"("website_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "keyword_website_id_intent_idx" ON "keyword"("website_id", "intent");

-- CreateIndex
CREATE UNIQUE INDEX "keyword_website_id_normalized_keyword_locale_language_marke_key" ON "keyword"("website_id", "normalized_keyword", "locale", "language", "market");

-- CreateIndex
CREATE INDEX "keyword_metrics_snapshot_website_id_captured_at_idx" ON "keyword_metrics_snapshot"("website_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "keyword_metrics_snapshot_keyword_id_captured_at_source_prov_key" ON "keyword_metrics_snapshot"("keyword_id", "captured_at", "source_provider");

-- CreateIndex
CREATE INDEX "ranking_snapshot_website_id_captured_at_idx" ON "ranking_snapshot"("website_id", "captured_at");

-- CreateIndex
CREATE INDEX "ranking_snapshot_page_id_captured_at_idx" ON "ranking_snapshot"("page_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "ranking_snapshot_keyword_id_captured_at_source_provider_key" ON "ranking_snapshot"("keyword_id", "captured_at", "source_provider");

-- CreateIndex
CREATE INDEX "keyword_page_ownership_website_id_status_idx" ON "keyword_page_ownership"("website_id", "status");

-- CreateIndex
CREATE INDEX "keyword_page_ownership_keyword_id_status_idx" ON "keyword_page_ownership"("keyword_id", "status");

-- CreateIndex
CREATE INDEX "keyword_page_ownership_page_id_idx" ON "keyword_page_ownership"("page_id");

-- CreateIndex
CREATE INDEX "topic_website_id_coverage_status_idx" ON "topic"("website_id", "coverage_status");

-- CreateIndex
CREATE UNIQUE INDEX "topic_website_id_slug_key" ON "topic"("website_id", "slug");

-- CreateIndex
CREATE INDEX "topic_keyword_keyword_id_idx" ON "topic_keyword"("keyword_id");

-- CreateIndex
CREATE UNIQUE INDEX "topic_keyword_topic_id_keyword_id_key" ON "topic_keyword"("topic_id", "keyword_id");

-- CreateIndex
CREATE INDEX "topic_page_page_id_idx" ON "topic_page"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "topic_page_topic_id_page_id_key" ON "topic_page"("topic_id", "page_id");

-- CreateIndex
CREATE INDEX "competitor_keyword_snapshot_website_id_captured_at_idx" ON "competitor_keyword_snapshot"("website_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_keyword_snapshot_competitor_id_keyword_id_captur_key" ON "competitor_keyword_snapshot"("competitor_id", "keyword_id", "captured_at", "source_provider");

-- CreateIndex
CREATE INDEX "import_website_id_created_at_idx" ON "import"("website_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_website_id_checksum_key" ON "import"("website_id", "checksum");

-- CreateIndex
CREATE INDEX "import_row_import_id_is_valid_idx" ON "import_row"("import_id", "is_valid");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_import_id_row_number_key" ON "import_row"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "opportunity_website_id_status_priority_idx" ON "opportunity"("website_id", "status", "priority");

-- CreateIndex
CREATE INDEX "opportunity_website_id_type_idx" ON "opportunity"("website_id", "type");

-- CreateIndex
CREATE INDEX "opportunity_keyword_id_idx" ON "opportunity"("keyword_id");

-- CreateIndex
CREATE INDEX "opportunity_evidence_opportunity_id_idx" ON "opportunity_evidence"("opportunity_id");

-- AddForeignKey
ALTER TABLE "keyword" ADD CONSTRAINT "keyword_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_metrics_snapshot" ADD CONSTRAINT "keyword_metrics_snapshot_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_metrics_snapshot" ADD CONSTRAINT "keyword_metrics_snapshot_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_metrics_snapshot" ADD CONSTRAINT "keyword_metrics_snapshot_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_metrics_snapshot" ADD CONSTRAINT "keyword_metrics_snapshot_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "source_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_metrics_snapshot" ADD CONSTRAINT "keyword_metrics_snapshot_source_import_id_fkey" FOREIGN KEY ("source_import_id") REFERENCES "import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "source_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_source_import_id_fkey" FOREIGN KEY ("source_import_id") REFERENCES "import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_page_ownership" ADD CONSTRAINT "keyword_page_ownership_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_page_ownership" ADD CONSTRAINT "keyword_page_ownership_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_page_ownership" ADD CONSTRAINT "keyword_page_ownership_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_page_ownership" ADD CONSTRAINT "keyword_page_ownership_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_parent_topic_id_fkey" FOREIGN KEY ("parent_topic_id") REFERENCES "topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_pillar_page_id_fkey" FOREIGN KEY ("pillar_page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_commercial_destination_page_id_fkey" FOREIGN KEY ("commercial_destination_page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic" ADD CONSTRAINT "topic_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_keyword" ADD CONSTRAINT "topic_keyword_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_keyword" ADD CONSTRAINT "topic_keyword_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_page" ADD CONSTRAINT "topic_page_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_page" ADD CONSTRAINT "topic_page_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_keyword_snapshot" ADD CONSTRAINT "competitor_keyword_snapshot_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_keyword_snapshot" ADD CONSTRAINT "competitor_keyword_snapshot_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_keyword_snapshot" ADD CONSTRAINT "competitor_keyword_snapshot_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_keyword_snapshot" ADD CONSTRAINT "competitor_keyword_snapshot_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "source_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_keyword_snapshot" ADD CONSTRAINT "competitor_keyword_snapshot_source_import_id_fkey" FOREIGN KEY ("source_import_id") REFERENCES "import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import" ADD CONSTRAINT "import_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import" ADD CONSTRAINT "import_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "import"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keyword"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_business_goal_id_fkey" FOREIGN KEY ("business_goal_id") REFERENCES "business_goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_source_signal_id_fkey" FOREIGN KEY ("source_signal_id") REFERENCES "signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_evidence" ADD CONSTRAINT "opportunity_evidence_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
