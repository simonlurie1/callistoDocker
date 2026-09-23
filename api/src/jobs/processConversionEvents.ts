import "dotenv/config";
import { randomUUID } from "crypto";
import { createContainer } from "../container";
import { errorDetails, logContext, logger, setServiceName } from "../lib/logger";
import { logBatchResult } from "./logBatchResult";

// Runs a single batch pass and exits — the same work the scheduled worker
// does every tick, for triggering a pass on demand instead of waiting for
// the schedule (a demo, the e2e script, an ops fix). Safe to run while the
// worker is running: events are claimed before posting.
//   npm run process-conversions                              (locally)
//   docker compose exec api npm run process-conversions      (in Docker)
setServiceName("process-conversions");
const { conversionBatchService, close } = createContainer();

logContext
  .run({ passId: randomUUID().slice(0, 8) }, async () => {
    logger.info("batch pass started (manual)");
    logBatchResult(await conversionBatchService.runOnce());
  })
  .catch((err) => {
    logger.error("batch pass failed", { error: errorDetails(err) });
    process.exitCode = 1;
  })
  .finally(close);
