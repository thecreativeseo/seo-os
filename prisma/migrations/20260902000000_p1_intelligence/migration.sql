-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncType" AS ENUM ('GSC_METRICS', 'GA4_METRICS', 'SITEMAP_FETCH');

-- CreateEnum
CREATE TYPE "SearchType" AS ENUM ('WEB', 'IMAGE', 'VIDEO', 'NEWS', 'DISCOVER');

-- CreateEnum
CREATE TYPE "PageSource" AS ENUM ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS', 'SITEMAP', 'MANUAL');

-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('HOME', 'COMMERCIAL', 'BLOG_POST', 'CATEGORY', 'LANDING', 'DOCUMENTATION', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SitemapFetchStatus" AS ENUM ('NEVER_FETCHED', 'FETCHING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('TRAFFIC_DECLINE', 'TRAFFIC_GROWTH', 'IMPRESSION_GROWTH', 'CTR_OPPORTUNITY', 'STRIKING_DISTANCE', 'PAGE_WINNER', 'PAGE_LOSER', 'QUERY_WINNER', 'QUERY_LOSER', 'DATA_FRESHNESS_RISK');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('DETECTED', 'REVIEWED', 'DISMISSED', 'PROMOTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SignalSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('METRIC_COMPARISON', 'THRESHOLD', 'SOURCE_FRESHNESS');

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "external_property_id" TEXT,
ADD COLUMN     "external_property_name" TEXT,
ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "latest_data_date" DATE,
ADD COLUMN     "property_selected_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "credential" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "ConnectionProvider" NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "normalized_url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "page_type" "PageType" NOT NULL DEFAULT 'UNKNOWN',
    "content_type" TEXT,
    "source_first_seen" "PageSource" NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sitemap_present" BOOLEAN NOT NULL DEFAULT false,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "normalized_query" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "query_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gsc_metric_daily" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "query_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ALL',
    "device" TEXT NOT NULL DEFAULT 'ALL',
    "search_type" "SearchType" NOT NULL DEFAULT 'WEB',
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DECIMAL(9,6),
    "position" DECIMAL(7,3),
    "source_connection_id" UUID NOT NULL,
    "source_snapshot_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gsc_metric_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ga4_landing_page_metric_daily" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "sessions" INTEGER,
    "engaged_sessions" INTEGER,
    "users" INTEGER,
    "new_users" INTEGER,
    "key_events" INTEGER,
    "conversions" INTEGER,
    "revenue" DECIMAL(18,4),
    "source_connection_id" UUID NOT NULL,
    "source_snapshot_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ga4_landing_page_metric_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_snapshot" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "ConnectionProvider" NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_start" DATE,
    "period_end" DATE,
    "object_storage_key" TEXT,
    "checksum" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "ConnectionProvider" NOT NULL,
    "sync_type" "SyncType" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "period_start" DATE,
    "period_end" DATE,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "records_received" INTEGER NOT NULL DEFAULT 0,
    "records_written" INTEGER NOT NULL DEFAULT 0,
    "records_skipped" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_summary" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sitemap" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "fetch_status" "SitemapFetchStatus" NOT NULL DEFAULT 'NEVER_FETCHED',
    "last_fetched_at" TIMESTAMP(3),
    "last_successful_fetch_at" TIMESTAMP(3),
    "url_count" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sitemap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "type" "SignalType" NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'DETECTED',
    "severity" "SignalSeverity" NOT NULL DEFAULT 'INFO',
    "page_id" UUID,
    "query_id" UUID,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_start" DATE NOT NULL,
    "current_period_end" DATE NOT NULL,
    "comparison_period_start" DATE NOT NULL,
    "comparison_period_end" DATE NOT NULL,
    "score" DECIMAL(9,4),
    "scoring_model_version" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "summary" TEXT,
    "evidence_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_evidence" (
    "id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "evidence_type" "EvidenceType" NOT NULL,
    "source_entity_type" TEXT NOT NULL,
    "source_entity_id" TEXT NOT NULL,
    "metric_key" TEXT NOT NULL,
    "current_value" DECIMAL(18,4),
    "previous_value" DECIMAL(18,4),
    "period_start" DATE,
    "period_end" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_connection_id_key" ON "credential"("connection_id");

-- CreateIndex
CREATE INDEX "page_website_id_last_seen_at_idx" ON "page"("website_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "page_website_id_normalized_url_key" ON "page"("website_id", "normalized_url");

-- CreateIndex
CREATE INDEX "query_website_id_last_seen_at_idx" ON "query"("website_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "query_website_id_normalized_query_key" ON "query"("website_id", "normalized_query");

-- CreateIndex
CREATE INDEX "gsc_metric_daily_website_id_date_idx" ON "gsc_metric_daily"("website_id", "date");

-- CreateIndex
CREATE INDEX "gsc_metric_daily_page_id_date_idx" ON "gsc_metric_daily"("page_id", "date");

-- CreateIndex
CREATE INDEX "gsc_metric_daily_query_id_date_idx" ON "gsc_metric_daily"("query_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "gsc_metric_daily_website_id_date_page_id_query_id_country_d_key" ON "gsc_metric_daily"("website_id", "date", "page_id", "query_id", "country", "device", "search_type");

-- CreateIndex
CREATE INDEX "ga4_landing_page_metric_daily_website_id_date_idx" ON "ga4_landing_page_metric_daily"("website_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ga4_landing_page_metric_daily_website_id_date_page_id_key" ON "ga4_landing_page_metric_daily"("website_id", "date", "page_id");

-- CreateIndex
CREATE INDEX "source_snapshot_website_id_captured_at_idx" ON "source_snapshot"("website_id", "captured_at");

-- CreateIndex
CREATE INDEX "sync_run_website_id_created_at_idx" ON "sync_run"("website_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_run_connection_id_idempotency_key_key" ON "sync_run"("connection_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "sitemap_website_id_url_key" ON "sitemap"("website_id", "url");

-- CreateIndex
CREATE INDEX "signal_website_id_status_severity_idx" ON "signal"("website_id", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "signal_website_id_type_page_id_query_id_current_period_star_key" ON "signal"("website_id", "type", "page_id", "query_id", "current_period_start");

-- CreateIndex
CREATE INDEX "signal_evidence_signal_id_idx" ON "signal_evidence"("signal_id");

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page" ADD CONSTRAINT "page_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query" ADD CONSTRAINT "query_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_metric_daily" ADD CONSTRAINT "gsc_metric_daily_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_metric_daily" ADD CONSTRAINT "gsc_metric_daily_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_metric_daily" ADD CONSTRAINT "gsc_metric_daily_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_metric_daily" ADD CONSTRAINT "gsc_metric_daily_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_metric_daily" ADD CONSTRAINT "gsc_metric_daily_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "source_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ga4_landing_page_metric_daily" ADD CONSTRAINT "ga4_landing_page_metric_daily_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ga4_landing_page_metric_daily" ADD CONSTRAINT "ga4_landing_page_metric_daily_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ga4_landing_page_metric_daily" ADD CONSTRAINT "ga4_landing_page_metric_daily_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ga4_landing_page_metric_daily" ADD CONSTRAINT "ga4_landing_page_metric_daily_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "source_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_snapshot" ADD CONSTRAINT "source_snapshot_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_snapshot" ADD CONSTRAINT "source_snapshot_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sitemap" ADD CONSTRAINT "sitemap_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

