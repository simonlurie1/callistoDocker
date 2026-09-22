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

/**
 * pending    — waiting to be posted (new, or re-queued by a re-convert)
 * in_process — claimed by a worker that is posting it right now
 * sent       — the tracker has it (accepted or duplicate)
 * failed     — last attempt failed; retried later if nextRetryAt is set
 */
export type ConversionEventStatus = "pending" | "in_process" | "sent" | "failed";

/** What gets reported to the tracker for a conversion (its wire field names). */
export interface ConversionPayload {
  event_id: string;
  event_name?: string;
  email?: string;
  phone?: string;
  lead_id?: string;
  amount?: number;
  currency?: string;
  occurred_at?: string;
}

export interface ConversionEvent {
  id: number;
  eventId: string;
  leadId: number;
  status: ConversionEventStatus;
  attempts: number;
  /** Persisted before the first send and resent unchanged on every retry. */
  payload: ConversionPayload;
  /** null when the last attempt got no HTTP response (network error / timeout). */
  responseStatus: number | null;
  /** Raw response body of the last attempt, kept verbatim for auditing. */
  responseBody: string | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  /** When the current worker claimed it; set only while status is in_process. */
  processingStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
