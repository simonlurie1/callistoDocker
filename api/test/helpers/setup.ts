import { ConversionBatchService } from "../../src/services/conversionBatchService";
import { ConversionService } from "../../src/services/conversionService";
import { LeadService } from "../../src/services/leadService";
import { FakeTracker } from "./fakeTracker";
import { InMemoryConversionEventRepository, InMemoryLeadRepository } from "./inMemoryRepositories";

/**
 * The same wiring as src/container.ts, but with the in-memory repositories
 * and the fake tracker instead of Prisma and HTTP.
 */
export function createTestServices(options: { batchSize?: number; staleAfterMs?: number } = {}) {
  const events = new InMemoryConversionEventRepository();
  const leads = new InMemoryLeadRepository(events);
  const tracker = new FakeTracker();
  const conversionService = new ConversionService(events, tracker);
  const leadService = new LeadService(leads, conversionService);
  const batchService = new ConversionBatchService(events, leads, conversionService, {
    batchSize: options.batchSize ?? 10,
    staleAfterMs: options.staleAfterMs ?? 5 * 60_000,
  });
  return { events, leads, tracker, conversionService, leadService, batchService };
}

/** Valid input for a lead that can be converted. */
export const convertibleLead = {
  name: "Dana Cohen",
  email: "dana@example.com",
  phone: null,
  source: "facebook",
  amount: 199.5,
  currency: "USD",
};
