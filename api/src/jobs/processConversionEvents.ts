import "dotenv/config";
import { createContainer } from "../container";

// Runs a single batch pass and exits — the same work the worker does each
// tick, useful for triggering a pass by hand. Safe to run while workers are
// running: events are claimed before posting.
//   npm run process-conversions                              (locally)
//   docker compose exec api npm run process-conversions      (in Docker)
const { conversionBatchService, close } = createContainer();

async function main() {
  const { found, posted, skipped } = await conversionBatchService.runOnce();
  if (found === 0) {
    console.log("no conversion events need posting");
    return;
  }
  for (const event of posted) {
    console.log(
      `event ${event.eventId}: attempt #${event.attempts} -> status=${event.status} httpStatus=${event.responseStatus ?? "none"}`
    );
  }
  if (skipped > 0) console.log(`${skipped} event(s) claimed by another worker`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(close);
