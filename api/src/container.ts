import { createPrismaRepositories } from "./repositories/prisma";
import { ConversionService } from "./services/conversionService";
import { LeadService } from "./services/leadService";

export interface Container {
  leadService: LeadService;
  conversionService: ConversionService;
  close(): Promise<void>;
}

// Composition root: the only place that chooses the Prisma implementations.
// Everything downstream receives repository interfaces, so swapping storage
// (or passing in-memory fakes in tests) is a change here only.
export function createContainer(): Container {
  const repositories = createPrismaRepositories();
  const conversionService = new ConversionService(repositories.conversionEvents);
  const leadService = new LeadService(repositories.leads, conversionService);

  return {
    leadService,
    conversionService,
    close: () => repositories.disconnect(),
  };
}
