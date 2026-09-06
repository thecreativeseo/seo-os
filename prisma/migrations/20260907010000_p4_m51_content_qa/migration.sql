-- CreateEnum
CREATE TYPE "ContentQaRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentQaSource" AS ENUM ('DETERMINISTIC', 'AI_JUDGED', 'MIXED');

-- CreateEnum
CREATE TYPE "ContentCmsApprovalStatus" AS ENUM ('APPROVED', 'INVALIDATED');

-- AlterEnum
ALTER TYPE "ContentQaStatus" ADD VALUE 'NOT_CHECKED';

-- AlterTable
ALTER TABLE "content_qa_result" ADD COLUMN     "not_checked_reason" TEXT,
ADD COLUMN     "qa_run_id" UUID NOT NULL,
ADD COLUMN     "revision_hash" TEXT NOT NULL,
ADD COLUMN     "source" "ContentQaSource" NOT NULL DEFAULT 'DETERMINISTIC';

-- CreateTable
CREATE TABLE "content_qa_run" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "content_draft_id" UUID NOT NULL,
    "content_revision_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "brief_id" UUID NOT NULL,
    "brief_version" INTEGER NOT NULL,
    "context_version_id" UUID,
    "evidence_package_id" UUID,
    "ai_run_id" UUID,
    "inputs_fingerprint" TEXT NOT NULL,
    "status" "ContentQaRunStatus" NOT NULL DEFAULT 'RUNNING',
    "outcome" "ContentQaStatus",
    "blocking_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "info_count" INTEGER NOT NULL DEFAULT 0,
    "not_checked_count" INTEGER NOT NULL DEFAULT 0,
    "checker_version" TEXT NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_qa_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_cms_approval" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "content_draft_id" UUID NOT NULL,
    "content_revision_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "qa_run_id" UUID NOT NULL,
    "brief_id" UUID NOT NULL,
    "brief_version" INTEGER NOT NULL,
    "brief_superseded_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "not_checked_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_json" JSONB,
    "status" "ContentCmsApprovalStatus" NOT NULL DEFAULT 'APPROVED',
    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "self_decided" BOOLEAN NOT NULL DEFAULT false,
    "invalidated_at" TIMESTAMP(3),
    "invalidated_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_cms_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_qa_run_website_id_created_at_idx" ON "content_qa_run"("website_id", "created_at");

-- CreateIndex
CREATE INDEX "content_qa_run_content_work_item_id_created_at_idx" ON "content_qa_run"("content_work_item_id", "created_at");

-- CreateIndex
CREATE INDEX "content_qa_run_content_revision_id_idx" ON "content_qa_run"("content_revision_id");

-- CreateIndex
CREATE INDEX "content_qa_run_website_id_status_idx" ON "content_qa_run"("website_id", "status");

-- CreateIndex
CREATE INDEX "content_cms_approval_website_id_status_idx" ON "content_cms_approval"("website_id", "status");

-- CreateIndex
CREATE INDEX "content_cms_approval_content_work_item_id_created_at_idx" ON "content_cms_approval"("content_work_item_id", "created_at");

-- CreateIndex
CREATE INDEX "content_cms_approval_qa_run_id_idx" ON "content_cms_approval"("qa_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_qa_result_qa_run_id_qa_type_key" ON "content_qa_result"("qa_run_id", "qa_type");

-- AddForeignKey
ALTER TABLE "content_qa_result" ADD CONSTRAINT "content_qa_result_qa_run_id_fkey" FOREIGN KEY ("qa_run_id") REFERENCES "content_qa_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_content_draft_id_fkey" FOREIGN KEY ("content_draft_id") REFERENCES "content_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "content_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "content_brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_context_version_id_fkey" FOREIGN KEY ("context_version_id") REFERENCES "business_context_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "evidence_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_ai_run_id_fkey" FOREIGN KEY ("ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_qa_run" ADD CONSTRAINT "content_qa_run_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_content_draft_id_fkey" FOREIGN KEY ("content_draft_id") REFERENCES "content_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "content_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_qa_run_id_fkey" FOREIGN KEY ("qa_run_id") REFERENCES "content_qa_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "content_brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_cms_approval" ADD CONSTRAINT "content_cms_approval_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- P4 M5.1 integrity (M5 plan §15, D2, D3, D11). Hand-written, below the
-- generated part. Every constraint here is one the services also enforce;
-- the database holds the line when they do not.
-- ---------------------------------------------------------------------------

-- One QA run at a time per work item.
CREATE UNIQUE INDEX "content_qa_run_running_per_item"
  ON "content_qa_run" ("content_work_item_id")
  WHERE "status" = 'RUNNING';

-- One effective approval per work item.
CREATE UNIQUE INDEX "content_cms_approval_active_per_item"
  ON "content_cms_approval" ("content_work_item_id")
  WHERE "status" = 'APPROVED';

-- A result belongs to its run's revision, at its run's hash, and is written
-- while the run is still running. Results never change.
CREATE OR REPLACE FUNCTION enforce_content_qa_result_binding()
RETURNS TRIGGER AS $$
DECLARE
  run_revision uuid;
  run_hash text;
  run_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_qa_result % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'content_qa_result % is immutable (attempted UPDATE)', OLD.id;
  END IF;

  SELECT r."content_revision_id", r."revision_hash", r."status"
    INTO run_revision, run_hash, run_status
    FROM "content_qa_run" r
   WHERE r."id" = NEW."qa_run_id";

  IF run_revision IS NULL THEN
    RAISE EXCEPTION 'content_qa_result names a run that does not exist';
  END IF;
  IF run_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'content_qa_result cannot be added to run %, which is %', NEW."qa_run_id", run_status;
  END IF;
  IF NEW."content_revision_id" <> run_revision OR NEW."revision_hash" <> run_hash THEN
    RAISE EXCEPTION 'content_qa_result does not match the revision and hash of run %', NEW."qa_run_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_qa_result_bound_to_run
  BEFORE INSERT OR UPDATE OR DELETE ON "content_qa_result"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_qa_result_binding();

-- A run is written once: RUNNING at creation, then one completion. After that
-- it is history.
CREATE OR REPLACE FUNCTION enforce_content_qa_run_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_qa_run % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'content_qa_run % is % and immutable (attempted UPDATE)', OLD.id, OLD."status";
  END IF;

  IF NEW."content_revision_id" <> OLD."content_revision_id"
     OR NEW."revision_hash" <> OLD."revision_hash"
     OR NEW."content_work_item_id" <> OLD."content_work_item_id"
     OR NEW."requested_by_user_id" <> OLD."requested_by_user_id" THEN
    RAISE EXCEPTION 'content_qa_run % binding cannot change', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_qa_run_completed_immutable
  BEFORE UPDATE OR DELETE ON "content_qa_run"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_qa_run_immutability();

-- An approval only ever goes APPROVED -> INVALIDATED, with everything it
-- pinned exactly as it was.
CREATE OR REPLACE FUNCTION enforce_content_cms_approval_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_cms_approval % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'content_cms_approval % is % and immutable (attempted UPDATE)', OLD.id, OLD."status";
  END IF;
  IF NEW."status" <> 'INVALIDATED' THEN
    RAISE EXCEPTION 'content_cms_approval % may only be invalidated', OLD.id;
  END IF;
  IF NEW."content_revision_id" <> OLD."content_revision_id"
     OR NEW."revision_hash" <> OLD."revision_hash"
     OR NEW."qa_run_id" <> OLD."qa_run_id"
     OR NEW."content_work_item_id" <> OLD."content_work_item_id"
     OR NEW."approved_by_user_id" <> OLD."approved_by_user_id"
     OR NEW."approved_at" <> OLD."approved_at"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."acknowledged_json" IS DISTINCT FROM OLD."acknowledged_json"
     OR NEW."brief_superseded_acknowledged" <> OLD."brief_superseded_acknowledged"
     OR NEW."not_checked_acknowledged" <> OLD."not_checked_acknowledged"
     OR NEW."self_decided" <> OLD."self_decided" THEN
    RAISE EXCEPTION 'content_cms_approval % pins cannot change', OLD.id;
  END IF;
  IF NEW."invalidated_reason" IS NULL OR length(trim(NEW."invalidated_reason")) = 0 THEN
    RAISE EXCEPTION 'content_cms_approval % needs a reason to be invalidated', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_cms_approval_immutable
  BEFORE UPDATE OR DELETE ON "content_cms_approval"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_cms_approval_immutability();
