-- P4 M1 follow-up: the referential actions the tolerant triggers assume.
-- People who authored, approved, requested, decided or resolved something
-- are RESTRICT: not deletable while the row exists. An AI run that wrote a
-- revision is SET NULL: the run can be torn down, the words stay.

-- DropForeignKey
ALTER TABLE "content_brief" DROP CONSTRAINT "content_brief_approved_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "content_draft" DROP CONSTRAINT "content_draft_approved_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "content_revision" DROP CONSTRAINT "content_revision_created_by_ai_run_id_fkey";

-- DropForeignKey
ALTER TABLE "content_revision" DROP CONSTRAINT "content_revision_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "execution_verification" DROP CONSTRAINT "execution_verification_resolved_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "publish_approval" DROP CONSTRAINT "publish_approval_decided_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "publish_approval" DROP CONSTRAINT "publish_approval_requested_by_user_id_fkey";

-- AddForeignKey
ALTER TABLE "content_brief" ADD CONSTRAINT "content_brief_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_created_by_ai_run_id_fkey" FOREIGN KEY ("created_by_ai_run_id") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_revision" ADD CONSTRAINT "content_revision_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_approval" ADD CONSTRAINT "publish_approval_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_verification" ADD CONSTRAINT "execution_verification_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

