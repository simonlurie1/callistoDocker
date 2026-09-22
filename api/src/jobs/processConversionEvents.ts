import "dotenv/config";
import { createContainer } from "../container";

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
const { conversionService, close } = createContainer();

async function main() {
  const due = await conversionService.findDueForRetry();

  if (due.length === 0) {
    console.log("no conversion events due for retry");
    return;
  }

  console.log(`retrying ${due.length} conversion event(s)`);
  for (const event of due) {
    const updated = await conversionService.attemptSend(event);
    console.log(
      `event ${updated.eventId}: attempt #${updated.attempts} -> status=${updated.status} httpStatus=${updated.responseStatus}`
    );
    // Stay well under the 30 req/min tracker rate limit when a batch is due.
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
  .finally(close);
