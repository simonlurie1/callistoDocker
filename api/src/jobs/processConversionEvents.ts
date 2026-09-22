import "dotenv/config";
import { prisma } from "../lib/prisma";
import { attemptSend } from "../services/conversionService";

// Picks up any conversion events that still need work:
//  - status = pending, never attempted at all (e.g. the process crashed
//    right after the initial insert, before the inline send happened)
//  - status = failed AND due for a retry (nextRetryAt <= now); a failed
//    event with nextRetryAt = null was a non-retryable error (422/401) and
//    is intentionally left alone
//
// Run this on a schedule (cron, Task Scheduler, a sidecar container, etc.)
// or by hand:
//   npm run process-conversions        (locally)
//   docker compose exec api npm run process-conversions   (in Docker)
async function main() {
  const now = new Date();
  const candidates = await prisma.conversionEvent.findMany({
    where: { status: { in: ["pending", "failed"] } },
  });

  const due = candidates.filter((event) => {
    if (event.status === "pending") return true;
    return event.nextRetryAt !== null && event.nextRetryAt <= now;
  });

  if (due.length === 0) {
    console.log("no conversion events due for retry");
    return;
  }

  console.log(`retrying ${due.length} conversion event(s)`);
  for (const event of due) {
    // Stay well under the 30 req/min tracker rate limit when a batch is due.
    const updated = await attemptSend(event);
    console.log(
      `event ${updated.eventId}: attempt #${updated.attempts} -> status=${updated.status} httpStatus=${updated.responseStatus}`
    );
    await sleep(1000);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
