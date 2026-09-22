import type { ConversionEvent, ConversionEventStatus } from "../domain/models";

export interface NewConversionEvent {
  eventId: string;
  leadId: number;
  requestBody: string;
}

/** Outcome of one send attempt, recorded on the event row. */
export interface AttemptRecord {
  status: ConversionEventStatus;
  responseStatus: number;
  responseBody: string;
  lastError: string | null;
  attemptedAt: Date;
  /** null = no retry scheduled (success, or a non-retryable failure). */
  nextRetryAt: Date | null;
}

export interface ConversionEventRepository {
  findByLeadId(leadId: number): Promise<ConversionEvent | null>;
  /** Newest first. */
  findAll(): Promise<ConversionEvent[]>;
  /**
   * Inserts a "pending" event with 0 attempts. There is at most one event per
   * lead: if one already exists — including one inserted concurrently by
   * another request (e.g. a double-clicked convert) — that existing event is
   * returned instead and `event` is discarded.
   */
  createOrGetExisting(event: NewConversionEvent): Promise<ConversionEvent>;
  /**
   * Stores an attempt's outcome and increments `attempts` atomically, so
   * concurrent attempts on the same event never lose a count.
   */
  recordAttempt(id: number, attempt: AttemptRecord): Promise<ConversionEvent>;
  /**
   * Events that still need a send: "pending" (never attempted), or "failed"
   * with a nextRetryAt at or before `now`. A failed event with nextRetryAt =
   * null was non-retryable and is excluded.
   */
  findDueForRetry(now: Date): Promise<ConversionEvent[]>;
}
