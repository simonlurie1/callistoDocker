import { logger, type Logger } from "./lib/logger";
import { createPrismaRepositories } from "./repositories/prisma";
import { ConversionBatchService } from "./services/conversionBatchService";
import { ConversionService } from "./services/conversionService";
import { LeadService } from "./services/leadService";
import type { ConversionTracker } from "./tracker/ConversionTracker";
import { HttpConversionTracker } from "./tracker/http/HttpConversionTracker";

export interface Container {
  leadService: LeadService;
  conversionService: ConversionService;
  conversionBatchService: ConversionBatchService;
  tracker: ConversionTracker;
  logger: Logger;
  close(): Promise<void>;
}

// Composition root: the only place that picks concrete implementations
// (Prisma for storage, HTTP for the tracker, winston for logging) and reads
// their configuration. Everything downstream receives interfaces, so
// swapping any of them (or passing in-memory fakes in tests) is a change
// here only.
export function createContainer(): Container {
  const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

  const repositories = createPrismaRepositories();
  const tracker = new HttpConversionTracker(
    {
      baseUrl: process.env.TRACKER_BASE_URL ?? "https://bipro2interface.sseku.com/api/candidate-tracker",
      apiKey: process.env.TRACKER_API_KEY ?? "",
      timeoutMs: env("TRACKER_TIMEOUT_MS", 10_000),
      minIntervalMs: env("TRACKER_MIN_INTERVAL_MS", 2_100),
    },
    logger.child({ component: "tracker" })
  );

  const conversionService = new ConversionService(repositories.conversionEvents, tracker);
  const leadService = new LeadService(repositories.leads, conversionService);
  const conversionBatchService = new ConversionBatchService(
    repositories.conversionEvents,
    repositories.leads,
    conversionService,
    {
      batchSize: env("WORKER_BATCH_SIZE", 10),
      staleAfterMs: env("WORKER_STALE_AFTER_MS", 5 * 60_000),
    }
  );

  return {
    leadService,
    conversionService,
    conversionBatchService,
    tracker,
    logger,
    close: () => repositories.disconnect(),
  };
}
