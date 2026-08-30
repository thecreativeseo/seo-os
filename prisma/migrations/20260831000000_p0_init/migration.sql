-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'SEO_LEAD', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WebsiteType" AS ENUM ('MARKETING_SITE', 'ECOMMERCE', 'SAAS_PRODUCT', 'PUBLISHER', 'MARKETPLACE', 'LOCAL_BUSINESS', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CmsType" AS ENUM ('WORDPRESS', 'HUBSPOT_CMS', 'WEBFLOW', 'SHOPIFY', 'DRUPAL', 'CUSTOM', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('IN_PROGRESS', 'REVIEW', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ContextStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'MET', 'MISSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CompetitorType" AS ENUM ('DIRECT', 'ADJACENT', 'SEARCH', 'PUBLISHER', 'AGGREGATOR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SeoRuleSeverity" AS ENUM ('INFO', 'WARNING', 'BLOCKING');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('USER_PROVIDED', 'SYSTEM_DERIVED', 'INFERRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConnectionProvider" AS ENUM ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS', 'HUBSPOT', 'SEMRUSH', 'SIMILARWEB', 'SCREAMING_FROG', 'WORDPRESS');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR', 'REAUTH_REQUIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'ARCHIVE', 'APPROVE', 'REJECT', 'RETIRE', 'COMPLETE', 'SIGN_IN');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "auth_user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_membership" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "invited_by_user_id" UUID,
    "joined_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT,
    "domain" TEXT NOT NULL,
    "normalized_domain" TEXT NOT NULL,
    "canonical_url" TEXT,
    "website_type" "WebsiteType",
    "cms_type" "CmsType",
    "primary_market" TEXT,
    "primary_language" TEXT,
    "timezone" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "website_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_session" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "current_step" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "answers_json" JSONB NOT NULL DEFAULT '{}',
    "started_by_user_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_context" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "current_approved_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_context_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_context_version" (
    "id" UUID NOT NULL,
    "business_context_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "ContextStatus" NOT NULL DEFAULT 'DRAFT',
    "company_summary" TEXT,
    "product_service" TEXT,
    "business_model" TEXT,
    "primary_customer" TEXT,
    "buyer_roles" TEXT[],
    "primary_market" TEXT,
    "languages" TEXT[],
    "primary_conversion" TEXT,
    "secondary_conversions" TEXT[],
    "business_priorities" TEXT[],
    "seo_priorities" TEXT[],
    "competitor_summary" TEXT,
    "differentiators" TEXT[],
    "brand_voice" TEXT,
    "priority_topics" TEXT[],
    "avoid_topics" TEXT[],
    "approved_claims" TEXT[],
    "prohibited_claims" TEXT[],
    "owner_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "business_context_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_goal" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "period_start" DATE,
    "period_end" DATE,
    "business_objective" TEXT,
    "seo_outcome" TEXT,
    "primary_metric" TEXT,
    "leading_indicator" TEXT,
    "baseline" DECIMAL(18,4),
    "baseline_source" TEXT,
    "baseline_date" DATE,
    "owner_user_id" UUID,
    "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "business_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_fact" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "fact_key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" "Provenance" NOT NULL DEFAULT 'USER_PROVIDED',
    "source_url" TEXT,
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PROPOSED',
    "owner_user_id" UUID,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "brand_fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "normalized_domain" TEXT,
    "type" "CompetitorType" NOT NULL DEFAULT 'UNKNOWN',
    "provided_by_user" BOOLEAN NOT NULL DEFAULT true,
    "source" "Provenance" NOT NULL DEFAULT 'USER_PROVIDED',
    "notes" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_rule" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "SeoRuleSeverity" NOT NULL DEFAULT 'INFO',
    "applies_to" TEXT,
    "owner_user_id" UUID,
    "effective_from" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "seo_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technical_context" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "cms" "CmsType",
    "hosting_notes" TEXT,
    "known_migrations" TEXT,
    "known_constraints" TEXT,
    "staging_available" BOOLEAN,
    "developer_contact" TEXT,
    "publication_process" TEXT,
    "technical_notes" TEXT,
    "owner_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technical_context_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "website_id" UUID,
    "provider" "ConnectionProvider" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "credential_reference" TEXT,
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID,
    "website_id" UUID,
    "actor_user_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "before_snapshot_json" JSONB,
    "after_snapshot_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_auth_user_id_key" ON "user"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "organization_membership_user_id_idx" ON "organization_membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_membership_organization_id_user_id_key" ON "organization_membership"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_organization_id_slug_key" ON "workspace"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "website_workspace_id_idx" ON "website"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "website_workspace_id_normalized_domain_key" ON "website"("workspace_id", "normalized_domain");

-- CreateIndex
CREATE INDEX "onboarding_session_organization_id_idx" ON "onboarding_session"("organization_id");

-- CreateIndex
CREATE INDEX "onboarding_session_workspace_id_idx" ON "onboarding_session"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_context_website_id_key" ON "business_context"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_context_current_approved_version_id_key" ON "business_context"("current_approved_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_context_version_business_context_id_version_number_key" ON "business_context_version"("business_context_id", "version_number");

-- CreateIndex
CREATE INDEX "business_goal_website_id_idx" ON "business_goal"("website_id");

-- CreateIndex
CREATE INDEX "brand_fact_website_id_idx" ON "brand_fact"("website_id");

-- CreateIndex
CREATE INDEX "competitor_website_id_idx" ON "competitor"("website_id");

-- CreateIndex
CREATE INDEX "seo_rule_website_id_idx" ON "seo_rule"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "technical_context_website_id_key" ON "technical_context"("website_id");

-- CreateIndex
CREATE INDEX "connection_workspace_id_idx" ON "connection"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "connection_website_id_provider_key" ON "connection"("website_id", "provider");

-- CreateIndex
CREATE INDEX "audit_event_organization_id_created_at_idx" ON "audit_event"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_website_id_created_at_idx" ON "audit_event"("website_id", "created_at");

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website" ADD CONSTRAINT "website_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_session" ADD CONSTRAINT "onboarding_session_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_session" ADD CONSTRAINT "onboarding_session_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_session" ADD CONSTRAINT "onboarding_session_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_session" ADD CONSTRAINT "onboarding_session_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context" ADD CONSTRAINT "business_context_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context" ADD CONSTRAINT "business_context_current_approved_version_id_fkey" FOREIGN KEY ("current_approved_version_id") REFERENCES "business_context_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context_version" ADD CONSTRAINT "business_context_version_business_context_id_fkey" FOREIGN KEY ("business_context_id") REFERENCES "business_context"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context_version" ADD CONSTRAINT "business_context_version_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context_version" ADD CONSTRAINT "business_context_version_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context_version" ADD CONSTRAINT "business_context_version_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_goal" ADD CONSTRAINT "business_goal_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_goal" ADD CONSTRAINT "business_goal_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_fact" ADD CONSTRAINT "brand_fact_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_fact" ADD CONSTRAINT "brand_fact_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor" ADD CONSTRAINT "competitor_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_rule" ADD CONSTRAINT "seo_rule_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_rule" ADD CONSTRAINT "seo_rule_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technical_context" ADD CONSTRAINT "technical_context_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technical_context" ADD CONSTRAINT "technical_context_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection" ADD CONSTRAINT "connection_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

