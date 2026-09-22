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
  /** New leads always start as "new". */
  create(fields: LeadFields): Promise<Lead>;
  /** Overwrites every field; null clears it. */
  update(id: number, fields: LeadFields): Promise<Lead>;
  updateStatus(id: number, status: LeadStatus): Promise<Lead>;
  delete(id: number): Promise<void>;
}
