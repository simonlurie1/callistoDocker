import type { Lead } from "../domain/models";
import type { LeadStatus } from "../lib/constants";

export interface LeadFilter {
  status?: LeadStatus;
  source?: string;
}

/** Every field except `status`, which only changes through `updateStatus`. */
export interface LeadFields {
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  amount: number | null;
  currency: string | null;
}

export interface LeadRepository {
  /** Newest first. */
  findMany(filter: LeadFilter): Promise<Lead[]>;
  findById(id: number): Promise<Lead | null>;
  /**
   * Leads stuck as "converted" with no conversion_events row at all — e.g.
   * the process crashed between updating the lead's status and recording
   * the event (two separate writes, not one transaction). Invisible to a
   * scan that only looks at conversion_events, so the batch worker checks
   * for this separately each pass and repairs it. Should be rare and this
   * list should normally be empty.
   */
  findConvertedWithoutEvent(): Promise<Lead[]>;
  /** New leads always start as "new". */
  create(fields: LeadFields): Promise<Lead>;
  /** Overwrites every field; null clears it. */
  update(id: number, fields: LeadFields): Promise<Lead>;
  updateStatus(id: number, status: LeadStatus): Promise<Lead>;
  delete(id: number): Promise<void>;
}
