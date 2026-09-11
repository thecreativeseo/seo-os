-- Signal.score is an ordering magnitude in count units and unbounded by
-- design; DECIMAL(9,4) overflowed on a real property (a CTR-opportunity score
-- of 188,993). Widening only: no data changes, no default, no index.

-- AlterTable
ALTER TABLE "signal" ALTER COLUMN "score" SET DATA TYPE DECIMAL(18,4);
