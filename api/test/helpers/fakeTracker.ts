import type { ConversionPayload } from "../../src/domain/models";
import type { ConversionTracker, DeliveryResult, PingResult } from "../../src/tracker/ConversionTracker";

/** Ready-made tracker results, one per outcome. */
export const trackerResults = {
  accepted: (): DeliveryResult => ({
    outcome: "accepted",
    httpStatus: 201,
    responseBody: '{"ok":true,"duplicate":false}',
    error: null,
    retryAfterSeconds: null,
  }),
  duplicate: (): DeliveryResult => ({
    outcome: "duplicate",
    httpStatus: 200,
    responseBody: '{"ok":true,"duplicate":true}',
    error: null,
    retryAfterSeconds: null,
  }),
  serverError: (retryAfterSeconds: number | null = null): DeliveryResult => ({
    outcome: "retryable_failure",
    httpStatus: 500,
    responseBody: '{"ok":false,"error":"server_error"}',
    error: null,
    retryAfterSeconds,
  }),
  noResponse: (error = "fetch failed"): DeliveryResult => ({
    outcome: "retryable_failure",
    httpStatus: null,
    responseBody: null,
    error,
    retryAfterSeconds: null,
  }),
  unauthorized: (): DeliveryResult => ({
    outcome: "permanent_failure",
    httpStatus: 401,
    responseBody: '{"ok":false,"error":"unauthorized"}',
    error: null,
    retryAfterSeconds: null,
  }),
};

/**
 * Stands in for the real tracker. Records every payload it's sent, and
 * answers with the results queued in `nextResults` (accepted once the queue
 * is empty).
 */
export class FakeTracker implements ConversionTracker {
  readonly sent: ConversionPayload[] = [];
  readonly nextResults: DeliveryResult[] = [];

  willRespond(...results: DeliveryResult[]): this {
    this.nextResults.push(...results);
    return this;
  }

  async send(payload: ConversionPayload): Promise<DeliveryResult> {
    this.sent.push(payload);
    return this.nextResults.shift() ?? trackerResults.accepted();
  }

  async ping(): Promise<PingResult> {
    return { httpStatus: 200, body: { ok: true }, error: null };
  }
}
