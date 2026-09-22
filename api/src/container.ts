import { createPrismaRepositories } from "./repositories/prisma";
import { ConversionService } from "./services/conversionService";
import { LeadService } from "./services/leadService";
import type { ConversionTracker } from "./tracker/ConversionTracker";
import { HttpConversionTracker } from "./tracker/http/HttpConversionTracker";

export interface Container {
  leadService: LeadService;
  conversionService: ConversionService;
  tracker: ConversionTracker;
  close(): Promise<void>;
}

// Composition root: the only place that picks concrete implementations
// (Prisma for storage, HTTP for the tracker) and reads their configuration.
// Everything downstream receives interfaces, so swapping either (or passing
// in-memory fakes in tests) is a change here only.
export function createContainer(): Container {
  const repositories = createPrismaRepositories();
  const tracker = new HttpConversionTracker({
    baseUrl: process.env.TRACKER_BASE_URL ?? "https://bipro2interface.sseku.com/api/candidate-tracker",
    apiKey: process.env.TRACKER_API_KEY ?? "",
    timeoutMs: Number(process.env.TRACKER_TIMEOUT_MS ?? 10_000),
  });

  const conversionService = new ConversionService(repositories.conversionEvents, tracker);
  const leadService = new LeadService(repositories.leads, conversionService);

  return {
    leadService,
    conversionService,
    tracker,
    close: () => repositories.disconnect(),
  };
}
