-- CreateEnum
CREATE TYPE "ContentDraftReviewStatus" AS ENUM ('REQUESTED', 'APPROVED', 'RETURNED', 'INVALIDATED');

-- AlterTable
ALTER TABLE "content_draft" ADD COLUMN     "approved_review_id" UUID;

-- CreateTable
CREATE TABLE "content_draft_review" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "content_work_item_id" UUID NOT NULL,
    "content_draft_id" UUID NOT NULL,
    "content_revision_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "brief_id" UUID NOT NULL,
    "brief_version" INTEGER NOT NULL,
    "brief_superseded_at_decision" BOOLEAN NOT NULL DEFAULT false,
    "brief_mismatch_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContentDraftReviewStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMP(3),
    "note" TEXT,
    "self_decided" BOOLEAN NOT NULL DEFAULT false,
    "invalidated_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_draft_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_draft_review_content_draft_id_created_at_idx" ON "content_draft_review"("content_draft_id", "created_at");

-- CreateIndex
CREATE INDEX "content_draft_review_website_id_status_idx" ON "content_draft_review"("website_id", "status");

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_approved_review_id_fkey" FOREIGN KEY ("approved_review_id") REFERENCES "content_draft_review"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_content_work_item_id_fkey" FOREIGN KEY ("content_work_item_id") REFERENCES "content_work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_content_draft_id_fkey" FOREIGN KEY ("content_draft_id") REFERENCES "content_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "content_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "content_brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft_review" ADD CONSTRAINT "content_draft_review_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- M4.5: review integrity, in the database (docs/P4_SPEC.md §25, §37).
-- ---------------------------------------------------------------------------

-- At most one open review request per draft.
CREATE UNIQUE INDEX "content_draft_review_open_per_draft"
  ON "content_draft_review" ("content_draft_id")
  WHERE "status" = 'REQUESTED';

-- A review row is decided exactly once. While REQUESTED it may take its one
-- decision (APPROVED, RETURNED) or be INVALIDATED; afterwards it never changes.
-- Deletes go only through the operator history switch, like every other
-- history table.
CREATE OR REPLACE FUNCTION enforce_content_draft_review_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_draft_review % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION
      'content_draft_review % is % and immutable (attempted UPDATE)', OLD.id, OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_draft_review_decided_immutable
  BEFORE UPDATE OR DELETE ON "content_draft_review"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_draft_review_immutability();
