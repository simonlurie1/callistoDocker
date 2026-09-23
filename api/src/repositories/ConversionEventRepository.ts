import type { ConversionEvent, ConversionEventStatus, ConversionPayload } from "../domain/models";

export interface NewConversionEvent {
  eventId: string;
  leadId: number;
  payload: ConversionPayload;
}

/** Outcome of one send attempt, recorded on the event row. */
export interface AttemptRecord {
  status: Extract<ConversionEventStatus, "sent" | "failed">;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  attemptedAt: Date;
  /** null = no retry scheduled (success, or a non-retryable failure). */
  nextRetryAt: Date | null;
}

/**
 * An event needs posting when it is:
 *  - pending (never attempted, or re-queued), or
 *  - failed with nextRetryAt <= now (a failed event with nextRetryAt = null
 *    was non-retryable and is left alone), or
 *  - in_process with processingStartedAt < staleBefore — claimed by a worker
 *    that never finished (crashed mid-post); reposting is safe because the
 *    tracker deduplicates on event_id.
 */
export interface PostingCriteria {
  now: Date;
  staleBefore: Date;
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
   * Puts a sent or failed event back to "pending" (clearing any scheduled
   * retry) so it gets posted again. Events that are pending or in_process are
   * left untouched. Returns the event as it is afterwards.
   */
  requeue(id: number): Promise<ConversionEvent>;
  /** Events that need posting (see PostingCriteria), oldest first. */
  findDueForPosting(criteria: PostingCriteria, limit: number): Promise<ConversionEvent[]>;
  /**
   * Atomically marks the event in_process with processingStartedAt = now, but
   * only if it still needs posting per `criteria`. Returns the claimed event,
   * or null if another worker claimed it first (or it no longer needs
   * posting). Only the claimer may post it.
   */
  claimForPosting(id: number, criteria: PostingCriteria): Promise<ConversionEvent | null>;
  /**
   * Stores an attempt's outcome, releases the claim (clears
   * processingStartedAt) and increments `attempts` atomically — but ONLY if
   * `processingStartedAt` on the row still equals `claimedAt` (the value the
   * claim returned). `claimedAt` acts as a fencing token: if a worker's claim
   * went stale mid-post and another worker reclaimed the event in the
   * meantime, `processingStartedAt` has since changed and this write is
   * skipped, returning null, rather than clobbering the new owner's claim or
   * overwriting the result it's about to record. The post to the tracker
   * still happened either way (harmlessly duplicated at worst, since
   * event_id is idempotent) — only the bookkeeping for the loser is dropped.
   */
  recordAttempt(id: number, claimedAt: Date, attempt: AttemptRecord): Promise<ConversionEvent | null>;
}
