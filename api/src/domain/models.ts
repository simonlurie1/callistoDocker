import type { LeadStatus } from "../lib/constants";

// Persistence-agnostic domain types. Services and routes use these, never
// the ORM's generated types, so the storage layer can change without
// touching business logic.

export interface Lead {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: LeadStatus;
  amount: number | null;
  currency: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ConversionEventStatus = "pending" | "sent" | "failed";

export interface ConversionEvent {
  id: number;
  eventId: string;
  leadId: number;
  status: ConversionEventStatus;
  attempts: number;
  /** Exact JSON body sent to the tracker (persisted before the first send). */
  requestBody: string;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
