-- P4 M4.1: revision lineage, claims, findings, word count, and the idempotency token.
-- Additive; the revision triggers are untouched (none of these are reference columns).

-- AlterTable
ALTER TABLE "content_revision" ADD COLUMN     "based_on_revision_number" INTEGER,
ADD COLUMN     "claims_json" JSONB,
ADD COLUMN     "constraint_findings_json" JSONB,
ADD COLUMN     "generation_token" TEXT,
ADD COLUMN     "word_count" INTEGER;


-- A retried generation carrying the same token finds its revision instead of making another.
CREATE UNIQUE INDEX "content_revision_generation_token"
  ON "content_revision" ("content_draft_id", "generation_token")
  WHERE "generation_token" IS NOT NULL;
