-- Search Console rollups (P1 GSC storage): one row per page per day and one
-- row per query per page per calendar month, derived from gsc_metric_daily and
-- kept indefinitely. Additive only: gsc_metric_daily, its indexes and its rows
-- are untouched. No retention, no deletion, no reader changes in this migration.

-- CreateTable
CREATE TABLE "gsc_page_daily" (
    "website_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DECIMAL(9,6),
    "position" DECIMAL(7,3),
    "computed_at" TIMESTAMP(3) NOT NULL,
    "source_max_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gsc_page_daily_pkey" PRIMARY KEY ("website_id","page_id","date")
);

-- CreateTable
CREATE TABLE "gsc_query_page_monthly" (
    "website_id" UUID NOT NULL,
    "query_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DECIMAL(9,6),
    "position" DECIMAL(7,3),
    "days_with_data" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    "source_max_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gsc_query_page_monthly_pkey" PRIMARY KEY ("website_id","query_id","page_id","month")
);

-- CreateIndex
CREATE INDEX "gsc_page_daily_website_id_date_idx" ON "gsc_page_daily"("website_id", "date");

-- CreateIndex
CREATE INDEX "gsc_query_page_monthly_website_id_month_idx" ON "gsc_query_page_monthly"("website_id", "month");

-- AddForeignKey
ALTER TABLE "gsc_page_daily" ADD CONSTRAINT "gsc_page_daily_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_page_daily" ADD CONSTRAINT "gsc_page_daily_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_query_page_monthly" ADD CONSTRAINT "gsc_query_page_monthly_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_query_page_monthly" ADD CONSTRAINT "gsc_query_page_monthly_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "query"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_query_page_monthly" ADD CONSTRAINT "gsc_query_page_monthly_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

