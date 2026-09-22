import type { ConversionPayload } from "../domain/models";

/**
 * - accepted / duplicate: the tracker has the conversion (duplicate = it
 *   already had this event_id), so delivery is done.
 * - retryable_failure: transient; the same event may succeed later.
 * - permanent_failure: resending the same payload won't help (e.g. rejected
 *   as invalid, or unauthorized).
 */
export type DeliveryOutcome = "accepted" | "duplicate" | "retryable_failure" | "permanent_failure";

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  /** null when no HTTP response was received. */
  httpStatus: number | null;
  /** Raw response body, for the audit trail. */
  responseBody: string | null;
  /** Why no response was received (network error, timeout), else null. */
  error: string | null;
}

export interface PingResult {
  httpStatus: number | null;
  body: unknown;
  error: string | null;
}

export interface ConversionTracker {
  send(payload: ConversionPayload): Promise<DeliveryResult>;
  ping(): Promise<PingResult>;
}
