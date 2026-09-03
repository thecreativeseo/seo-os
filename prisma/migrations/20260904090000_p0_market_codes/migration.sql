-- Markets as ISO codes, and room for more than one.
--
-- P0 asked "main market" as free text and stored whatever was typed. Keyword
-- identity coerced that into a code at use time (lib/keyword/market), which was
-- enough until P2's live connectors started sending the raw value to Semrush and
-- Ahrefs as a regional database — "united kingdom" is not one. The application
-- now stores codes. This migration gives both tables the second column and
-- brings the website rows it can recognise into line.
ALTER TABLE "website"
  ADD COLUMN "additional_markets" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "business_context_version"
  ADD COLUMN "additional_markets" TEXT[] NOT NULL DEFAULT '{}';

-- Website rows are operational and editable, so known names become codes here.
-- Only spellings the coercion layer already understands; anything else is left
-- for a person, because a wrong country is worse than an empty one.
UPDATE "website" SET "primary_market" = CASE lower(trim("primary_market"))
  WHEN 'philippines' THEN 'PH'  WHEN 'phl' THEN 'PH'
  WHEN 'united kingdom' THEN 'GB' WHEN 'uk' THEN 'GB' WHEN 'gbr' THEN 'GB'
  WHEN 'great britain' THEN 'GB' WHEN 'britain' THEN 'GB' WHEN 'england' THEN 'GB'
  WHEN 'united states' THEN 'US' WHEN 'united states of america' THEN 'US' WHEN 'usa' THEN 'US'
  WHEN 'australia' THEN 'AU' WHEN 'canada' THEN 'CA' WHEN 'singapore' THEN 'SG'
  WHEN 'malaysia' THEN 'MY' WHEN 'indonesia' THEN 'ID' WHEN 'india' THEN 'IN'
  WHEN 'new zealand' THEN 'NZ' WHEN 'ireland' THEN 'IE' WHEN 'germany' THEN 'DE'
  WHEN 'france' THEN 'FR' WHEN 'spain' THEN 'ES' WHEN 'japan' THEN 'JP'
  WHEN 'united arab emirates' THEN 'AE' WHEN 'uae' THEN 'AE' WHEN 'hong kong' THEN 'HK'
  WHEN 'vietnam' THEN 'VN' WHEN 'thailand' THEN 'TH'
  ELSE "primary_market" END
WHERE "primary_market" IS NOT NULL
  AND "primary_market" !~ '^[A-Z]{2}$';

-- Approved business_context_version rows are immutable by trigger and by rule,
-- and a draft is a person's unfinished sentence. Neither is rewritten here; the
-- interface renders a stored name as itself.
