import "dotenv/config";
import { randomUUID } from "crypto";
import cron from "node-cron";
import { createContainer } from "../container";
import { errorDetails, logContext, logger, setServiceName } from "../lib/logger";
import { logBatchResult } from "./logBatchResult";

// Long-running worker: runs a batch pass (repair orphaned conversions, find
// events that need posting, claim, post) on a cron schedule — every 5
// seconds by default — plus once at startup. Passes are frequent so a new
// conversion goes out within seconds; how long a *failed* event waits before
// its next attempt is set per event by the backoff (next_retry_at), not here. Runs as its own container
// (`worker` in docker-compose.yml); several replicas can run side by side
// since claims are atomic. For an immediate pass, run `process-conversions`.
//   npm run worker        (compiled)   |   npm run dev:worker   (tsx, watch)

setServiceName("worker");

const CRON_SCHEDULE = process.env.WORKER_CRON_SCHEDULE ?? "*/5 * * * * *";
if (!cron.validate(CRON_SCHEDULE)) {
  logger.error(`invalid WORKER_CRON_SCHEDULE "${CRON_SCHEDULE}"`);
  process.exit(1);
}

// node-cron's own messages (e.g. a missed execution) go to the same log.
const cronLog = logger.child({ component: "node-cron" });
cron.setLogger({
  info: (message) => cronLog.info(message),
  warn: (message) => cronLog.warn(message),
  error: (message, err) => cronLog.error(String(message), { error: errorDetails(err ?? message) }),
  debug: (message, err) => cronLog.debug(String(message), err ? { error: errorDetails(err) } : {}),
});

const { conversionBatchService, close } = createContainer();

let shuttingDown = false;
let inFlight: Promise<void> | null = null;

/** One pass, with every line it logs (including tracker calls) tagged with a passId. */
function runPass(trigger: "startup" | "schedule"): Promise<void> {
  const passId = randomUUID().slice(0, 8);
  inFlight = logContext.run({ passId }, async () => {
    // debug, not info: with a pass every few seconds, idle passes would flood the log.
    logger.debug(`batch pass started (${trigger})`);
    try {
      logBatchResult(await conversionBatchService.runOnce(() => shuttingDown), "debug");
    } catch (err) {
      // e.g. the database is down, so even the scan failed. The worker keeps
      // running; the next tick tries again.
      logger.error("batch pass failed, will retry on the next tick", { error: errorDetails(err) });
    }
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// noOverlap: if a pass is still running when the next tick fires, the tick
// is skipped rather than starting a second concurrent pass.
const task = cron.createTask(CRON_SCHEDULE, () => runPass("schedule"), { name: "post-conversions", noOverlap: true });
task.on("execution:overlap", () => {
  // Routine with a short schedule: a pass posting several events (throttled
  // to ~2s apart) outlasts a 5s tick.
  logger.debug("skipped a scheduled pass: the previous one is still running");
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received: stopping the schedule, letting an in-flight pass finish its current post`);
  await task.stop();
  await inFlight;
  await close();
  logger.info("conversion worker stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info(`conversion worker started: one pass now, then on schedule "${CRON_SCHEDULE}"`, {
  schedule: CRON_SCHEDULE,
});
// Run once immediately — otherwise a freshly (re)started worker would sit
// idle for up to a full interval — then follow the schedule.
void runPass("startup").then(async () => {
  if (shuttingDown) return;
  await task.start();
  logger.info(`next scheduled pass at ${task.getNextRun()?.toISOString() ?? "unknown"}`);
});
