import "dotenv/config";
import { createContainer } from "../container";
import type { ConversionEvent } from "../domain/models";

// Long-running worker: every WORKER_POLL_INTERVAL_MS it runs one batch pass
// (find events that need posting, claim, post). Runs as its own container
// (`worker` in docker-compose.yml); several replicas can run side by side.
//   npm run worker        (compiled)   |   npm run dev:worker   (tsx, watch)

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2_000);
const { conversionBatchService, close } = createContainer();

let stopping = false;
let wakeUp: (() => void) | null = null;

function stop(signal: string) {
  console.log(`${signal} received, finishing the current post and stopping`);
  stopping = true;
  wakeUp?.();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

/** Sleep that a shutdown signal can cut short. */
function idle(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeUp = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function logPosted(event: ConversionEvent) {
  const retry = event.nextRetryAt ? `, retry at ${event.nextRetryAt.toISOString()}` : "";
  console.log(
    `event ${event.eventId}: attempt #${event.attempts} -> ${event.status} (http ${event.responseStatus ?? "none"}${retry})`
  );
}

async function main() {
  console.log(`conversion worker started, polling every ${POLL_INTERVAL_MS}ms`);
  while (!stopping) {
    try {
      const result = await conversionBatchService.runOnce(() => stopping);
      result.posted.forEach(logPosted);
      if (result.skipped > 0) console.log(`${result.skipped} event(s) claimed by another worker`);
    } catch (err) {
      console.error("batch pass failed:", err);
    }
    if (!stopping) await idle(POLL_INTERVAL_MS);
  }
  console.log("conversion worker stopped");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(close);
