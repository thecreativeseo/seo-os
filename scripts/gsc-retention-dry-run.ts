import { prisma } from "@/server/db/prisma";
import { planGscRetentionDryRun } from "@/server/services/gsc-retention";

/**
 * The retention dry run, from the command line.
 *
 *   npm run gsc:retention:dry-run                every website with raw rows
 *   npm run gsc:retention:dry-run -- <websiteId>  one website
 *
 * Reads only. Prints the retention window, every website-month and its
 * decision, what a purge would remove if every safe month were purged, and a
 * SAFE / BLOCKED / NONE verdict. There is no flag that deletes and no mode
 * that does: the purge, when it exists, is a different command with its own
 * gate that runs this first. Ids, months and counts only — never row content.
 */

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const websiteId = process.argv[2];
  const run = await planGscRetentionDryRun(websiteId ? { websiteIds: [websiteId] } : {});

  console.log(
    JSON.stringify({
      at: "retention.dry-run",
      retentionRunId: run.retentionRunId,
      evaluatedAt: run.evaluatedAt,
      policy: run.policy,
      retentionMonths: run.retentionMonths,
      latestDataDate: run.latestDataDate,
      retainedFrom: run.retainedFrom,
      bytesPerRawRow: run.bytesPerRawRow,
      websites: run.websites.length,
    }),
  );

  for (const website of run.websites) {
    console.log(
      JSON.stringify({
        at: "retention.dry-run",
        website: website.websiteId,
        latestDataDate: website.latestDataDate,
        currentMonth: website.currentMonth,
        retainedFrom: website.retainedFrom,
      }),
    );
    for (const simulation of website.simulations) {
      console.log(
        JSON.stringify({
          at: "retention.dry-run",
          website: website.websiteId,
          simulation: simulation.label,
          current: simulation.current,
          previous: simulation.previous,
          today: simulation.today,
          afterPurge: simulation.afterPurge,
        }),
      );
    }
  }

  for (const record of run.records) {
    console.log(
      JSON.stringify({
        at: "retention.dry-run",
        website: record.websiteId,
        month: record.month,
        decision: record.decision,
        rollupEquality: record.rollupEquality,
        blockedReason: record.blockedReason,
        rawRows: record.rawRows,
        approx: megabytes(record.approxBytes),
        ms: record.durationMs,
      }),
    );
  }

  for (const month of run.months) {
    console.log(
      JSON.stringify({
        at: "retention.dry-run",
        month: month.month,
        websites: month.websites,
        safeToPurge: month.safe,
        states: month.states,
        rawRows: month.rawRows,
        approx: megabytes(month.approxBytes),
      }),
    );
  }

  console.log(
    JSON.stringify({
      at: "retention.dry-run",
      event: "done",
      verdict: run.verdict,
      wouldDeleteRows: run.purgeableRows,
      wouldReclaimApprox: megabytes(run.purgeableBytes),
      blocked: run.blocked,
      deleted: 0,
    }),
  );
}

main()
  .catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown";
    const code = (error as { code?: unknown })?.code;
    console.error(JSON.stringify({ at: "retention.dry-run", event: "failed", name, code }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
