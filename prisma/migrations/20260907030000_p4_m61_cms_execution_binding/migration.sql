-- P4 M6.1: binding an execution to the approval that authorized it.
--
-- Generated from the schema, then extended by hand with what Prisma cannot
-- express: the conditional binding requirement, the idempotency and external
-- entity indexes, the approval-chain trigger and the frozen external id.
--
-- Purely additive. Before this ran the execution table held 24 rows, all of
-- type PUBLISH_CONTENT and none with an external entity id, so every
-- conditional constraint below is vacuous for existing data.

-- CreateEnum
CREATE TYPE "CmsEntityType" AS ENUM ('POST', 'PAGE');

-- CreateEnum
CREATE TYPE "CmsCapability" AS ENUM ('READ_CONTENT', 'CREATE_DRAFT', 'UPDATE_DRAFT', 'PUBLISH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VerificationType" ADD VALUE 'CMS_STATUS_DRAFT';
ALTER TYPE "VerificationType" ADD VALUE 'SLUG_MATCH';
ALTER TYPE "VerificationType" ADD VALUE 'EXCERPT_MATCH';

-- AlterTable
ALTER TABLE "connection" ADD COLUMN     "auth_type" "CmsAuthType",
ADD COLUMN     "base_url" TEXT,
ADD COLUMN     "external_account_name" TEXT,
ADD COLUMN     "last_checked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "execution" ADD COLUMN     "content_cms_approval_id" UUID,
ADD COLUMN     "external_status" TEXT,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "permission_mode" "PublishingMode",
ADD COLUMN     "qa_run_id" UUID,
ADD COLUMN     "target_entity_type" "CmsEntityType";

-- CreateTable
CREATE TABLE "connection_capability" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "capability" "CmsCapability" NOT NULL,
    "entity_type" "CmsEntityType",
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_capability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_capability_website_id_idx" ON "connection_capability"("website_id");

-- CreateIndex
CREATE INDEX "connection_capability_connection_id_idx" ON "connection_capability"("connection_id");

-- CreateIndex
CREATE INDEX "execution_content_cms_approval_id_idx" ON "execution"("content_cms_approval_id");

-- AddForeignKey
ALTER TABLE "connection_capability" ADD CONSTRAINT "connection_capability_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_capability" ADD CONSTRAINT "connection_capability_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_content_cms_approval_id_fkey" FOREIGN KEY ("content_cms_approval_id") REFERENCES "content_cms_approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution" ADD CONSTRAINT "execution_qa_run_id_fkey" FOREIGN KEY ("qa_run_id") REFERENCES "content_qa_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- P4 M6.1 integrity the Prisma schema cannot express
-- (docs/P4_SPEC.md sections 21, 25, 26; the M6 plan, sections 3, 5, 25)
-- ---------------------------------------------------------------------------

-- One answer per question asked of a connection. entity_type is null for a
-- capability the CMS does not scope by resource, and NULLS NOT DISTINCT makes
-- that row unique too rather than infinitely repeatable.
CREATE UNIQUE INDEX "connection_capability_identity"
  ON "connection_capability" ("connection_id", "capability", "entity_type")
  NULLS NOT DISTINCT;

-- WordPress scopes creating, updating and publishing by content kind, and does
-- not scope reading. A row that gets that wrong is answering a question nobody
-- asked, so it is refused rather than stored and quietly never matched.
ALTER TABLE "connection_capability"
  ADD CONSTRAINT "connection_capability_scope"
  CHECK (
    ("capability" IN ('CREATE_DRAFT', 'UPDATE_DRAFT', 'PUBLISH') AND "entity_type" IS NOT NULL)
    OR ("capability" = 'READ_CONTENT' AND "entity_type" IS NULL)
  );

-- A CREATE_CMS_DRAFT execution carries every binding M6 needs to prove what it
-- was authorized to do. Other execution types - an internal link update - have
-- no CMS approval, so this is conditional rather than a NOT NULL on each column.
ALTER TABLE "execution"
  ADD CONSTRAINT "execution_cms_draft_bindings"
  CHECK (
    "execution_type" <> 'CREATE_CMS_DRAFT'
    OR (
      "content_cms_approval_id" IS NOT NULL
      AND "qa_run_id" IS NOT NULL
      AND "target_entity_type" IS NOT NULL
      AND "idempotency_key" IS NOT NULL
      AND "permission_mode" IS NOT NULL
    )
  );

-- The same operation, asked for twice, is one execution. The key is derived
-- server-side from the operation's identity and is never supplied by a browser.
CREATE UNIQUE INDEX "execution_idempotency_key"
  ON "execution" ("website_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- One external entity per work item and type. A second CMS draft for the same
-- work is refused by the database, not only by the service that means to.
CREATE UNIQUE INDEX "execution_external_entity_per_item_type"
  ON "execution" ("content_work_item_id", "execution_type")
  WHERE "external_entity_id" IS NOT NULL;

-- And one execution per external entity on a connection, so two work items
-- cannot both claim to have created the same post.
CREATE UNIQUE INDEX "execution_external_entity_per_connection"
  ON "execution" ("connection_id", "external_entity_id")
  WHERE "external_entity_id" IS NOT NULL;

-- These raise with the default SQLSTATE rather than a class 23 one.
-- Prisma maps 23001 on a table carrying a RESTRICT foreign key to a generic
-- "foreign key constraint violated" and discards the message, which would
-- leave a guard that cannot say what it refused or why.
--
-- The approval chain, proven here rather than trusted to the service.
--
-- On INSERT: an execution that names an approval must describe the same
-- website, work item, revision, hash and QA run as that approval, must use a
-- connection belonging to the same website, and the approval must be APPROVED
-- at that moment.
--
-- On UPDATE: none of those bindings may move. The status is deliberately NOT
-- re-checked, because an approval invalidated later is history and must not
-- reach back into the record of what was already done.
CREATE OR REPLACE FUNCTION enforce_execution_cms_binding()
RETURNS TRIGGER AS $$
DECLARE
  approval "content_cms_approval"%ROWTYPE;
  connection_website_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."website_id" <> OLD."website_id"
       OR NEW."content_work_item_id" <> OLD."content_work_item_id"
       OR NEW."content_revision_id" <> OLD."content_revision_id"
       OR NEW."revision_hash" <> OLD."revision_hash"
       OR NEW."execution_type" <> OLD."execution_type"
       OR NEW."connection_id" <> OLD."connection_id"
       OR NEW."content_cms_approval_id" IS DISTINCT FROM OLD."content_cms_approval_id"
       OR NEW."qa_run_id" IS DISTINCT FROM OLD."qa_run_id"
       OR NEW."target_entity_type" IS DISTINCT FROM OLD."target_entity_type"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" THEN
      RAISE EXCEPTION
        'execution % is bound to one authorization; its bindings cannot change', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."content_cms_approval_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO approval
    FROM "content_cms_approval"
    WHERE "id" = NEW."content_cms_approval_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'execution names content_cms_approval % which does not exist',
      NEW."content_cms_approval_id";
  END IF;

  IF approval."website_id" <> NEW."website_id"
     OR approval."content_work_item_id" <> NEW."content_work_item_id"
     OR approval."content_revision_id" <> NEW."content_revision_id"
     OR approval."revision_hash" <> NEW."revision_hash"
     OR approval."qa_run_id" IS DISTINCT FROM NEW."qa_run_id" THEN
    RAISE EXCEPTION
      'execution does not describe the same approved chain as content_cms_approval %',
      approval."id";
  END IF;

  IF approval."status" <> 'APPROVED' THEN
    RAISE EXCEPTION
      'content_cms_approval % is % and cannot authorize an execution',
      approval."id", approval."status";
  END IF;

  SELECT "website_id" INTO connection_website_id
    FROM "connection" WHERE "id" = NEW."connection_id";

  IF connection_website_id IS DISTINCT FROM NEW."website_id" THEN
    RAISE EXCEPTION
      'execution would use connection % which does not belong to website %',
      NEW."connection_id", NEW."website_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_cms_binding
  BEFORE INSERT OR UPDATE ON "execution"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_execution_cms_binding();

-- Once the CMS has told us what it created, that fact is frozen. Changing it
-- or clearing it would make the record of an external side effect editable.
CREATE OR REPLACE FUNCTION enforce_execution_external_id_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."external_entity_id" IS NOT NULL
     AND NEW."external_entity_id" IS DISTINCT FROM OLD."external_entity_id" THEN
    RAISE EXCEPTION
      'execution % created external entity %; it cannot be changed or cleared',
      OLD.id, OLD."external_entity_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_external_id_immutable
  BEFORE UPDATE ON "execution"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_execution_external_id_immutability();
