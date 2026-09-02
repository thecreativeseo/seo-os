-- Which business goal a keyword or topic serves.
--
-- P2_SPEC §18 gives Opportunity a business_goal_id, and the scoring model weights
-- business relevance at 3 - the joint heaviest. Without a way to state the link,
-- that weight rests on nothing and the queue ranks work in a vacuum.
--
-- The link is stated by a person and never inferred. A keyword is not evidence of
-- a business intention: "payroll software" might serve a demo-generation goal or
-- a brand-awareness one, and only somebody who knows the business can say which.
-- Guessing would put weight on the score that nobody put there.
--
-- An opportunity resolves its goal from the keyword first, then the topic. The
-- keyword is the more specific statement, so it wins.
ALTER TABLE "keyword"
  ADD COLUMN "business_goal_id" UUID,
  ADD CONSTRAINT "keyword_business_goal_id_fkey"
    FOREIGN KEY ("business_goal_id") REFERENCES "business_goal"("id") ON DELETE SET NULL;

ALTER TABLE "topic"
  ADD COLUMN "business_goal_id" UUID,
  ADD CONSTRAINT "topic_business_goal_id_fkey"
    FOREIGN KEY ("business_goal_id") REFERENCES "business_goal"("id") ON DELETE SET NULL;

CREATE INDEX "keyword_business_goal_id_idx" ON "keyword"("business_goal_id");
CREATE INDEX "topic_business_goal_id_idx" ON "topic"("business_goal_id");
