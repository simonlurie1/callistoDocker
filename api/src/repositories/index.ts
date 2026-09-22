import type { ConversionEventRepository } from "./ConversionEventRepository";
import type { LeadRepository } from "./LeadRepository";

export interface Repositories {
  leads: LeadRepository;
  conversionEvents: ConversionEventRepository;
  /** Releases the underlying connection (for short-lived processes like the retry job). */
  disconnect(): Promise<void>;
}
