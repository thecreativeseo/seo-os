import { prisma } from "@/server/db/prisma";
import { monthsTouched, recomputeGscRollups } from "@/server/services/gsc-rollups";

/**
 * Derives the Search Console rollups for every website and calendar month
 * that gsc_metric_daily holds, one (website, month) transaction at a time.
 *
 *   npm run db:backfill:gsc-rollups            every website
 *   npm run db:backfill:gsc-rollups -- <id>    one website
 *
 * Additive and idempotent: it reads raw and writes rollups, never the other
 * way round, and a month that is already derived is derived again to the
 * same values. Interrupt it and run it again; nothing is half done, because
 * a month is the unit of work and a transaction. Months are taken oldest
 * first with a short pause between them so the pooler and the WAL see a
 * steady trickle rather than one large statement. Prints counts only —
 * website ids, months, row counts, durations — never row content.
 */

const PAUSE_MS = 250;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const onlyWebsiteId = process.argv[2];

  const spans = await prisma.gscMetricDaily.groupBy({
    by: ["websiteId"],
    where: onlyWebsiteId ? { websiteId: onlyWebsiteId } : undefined,
    _min: { date: true },
    _max: { date: true },
    orderBy: { websiteId: "asc" },
  });

  const startedAt = Date.now();
  let months = 0;
  let pageDays = 0;
  let queryPageMonths = 0;

  for (const span of spans) {
    if (!span._min.date || !span._max.date) continue;

    const website = await prisma.website.findUnique({ where: { id: span.websiteId } });
    if (!website) continue;

    const range = { startDate: isoDate(span._min.date), endDate: isoDate(span._max.date) };
    const planned = monthsTouched(range);
    console.log(
      JSON.stringify({ at: "backfill", website: website.id, months: planned.length, range }),
    );

    for (const month of planned) {
      const began = Date.now();
      const result = await recomputeGscRollups(
        { website },
        { startDate: month, endDate: month },
      );
      months += 1;
      pageDays += result.pageDays;
      queryPageMonths += result.queryPageMonths;
      console.log(
        JSON.stringify({
          at: "backfill",
          website: website.id,
          month,
          pageDays: result.pageDays,
          queryPageMonths: result.queryPageMonths,
          ms: Date.now() - began,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  console.log(
    JSON.stringify({
      at: "backfill",
      event: "done",
      websites: spans.length,
      months,
      pageDays,
      queryPageMonths,
      ms: Date.now() - startedAt,
    }),
  );
}

main()
  .catch((error: unknown) => {
    // The class and code are enough to act on; the message may carry SQL.
    const name = error instanceof Error ? error.name : "unknown";
    const code = (error as { code?: unknown })?.code;
    console.error(JSON.stringify({ at: "backfill", event: "failed", name, code }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
