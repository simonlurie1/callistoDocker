import { randomUUID } from "crypto";
import type { ConversionEvent, Lead } from "../domain/models";
import type { ConversionEventRepository } from "../repositories/ConversionEventRepository";
import { ping as trackerPing, postConversion, ConversionPayload } from "../lib/trackerClient";
import { nextRetryDelaySeconds } from "../lib/backoff";

function buildPayload(lead: Lead, eventId: string): ConversionPayload {
  return {
    event_id: eventId,
    event_name: "purchase",
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    lead_id: String(lead.id),
    amount: lead.amount ?? undefined,
    currency: lead.currency ?? undefined,
    occurred_at: new Date().toISOString(),
  };
}

export class ConversionService {
  constructor(private readonly events: ConversionEventRepository) {}

  /**
   * Entry point called right after a lead's status transitions to "converted"
   * (including re-converting an already-converted lead, which is how the
   * tracker's own idempotency gets exercised: same event_id, tracker replies
   * 200 duplicate:true instead of creating a second conversion). Persists the
   * event first (if it doesn't already exist), then makes one immediate send
   * attempt. If that attempt fails with a retryable error, the row is left
   * for the retry worker (npm run process-conversions) to pick up later.
   */
  async dispatchForLead(lead: Lead): Promise<ConversionEvent> {
    const event = await this.getOrCreateEvent(lead);
    return this.attemptSend(event);
  }

  /**
   * Step 2: actually send the persisted event, and record exactly what came
   * back (or what went wrong) on the same row.
   */
  async attemptSend(event: ConversionEvent): Promise<ConversionEvent> {
    const payload = JSON.parse(event.requestBody) as ConversionPayload;
    const result = await postConversion(payload);

    const isNetworkFailure = result.httpStatus === 0;
    const isServerError = result.httpStatus >= 500;
    // 429 (the tracker's 30 req/min limit) and 408 are transient, like a 5xx.
    const isTransientClientError = result.httpStatus === 429 || result.httpStatus === 408;
    const bodyObj = result.body as { duplicate?: boolean } | null;
    const isSuccess =
      result.httpStatus === 201 || (result.httpStatus === 200 && bodyObj?.duplicate === true);
    const retryable = isNetworkFailure || isServerError || isTransientClientError;

    return this.events.recordAttempt(event.id, {
      status: isSuccess ? "sent" : "failed",
      responseStatus: result.httpStatus,
      responseBody:
        typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? null),
      lastError: isSuccess ? null : result.networkError ?? null,
      attemptedAt: new Date(),
      nextRetryAt:
        !isSuccess && retryable
          ? new Date(Date.now() + nextRetryDelaySeconds(event.attempts + 1) * 1000)
          : null,
    });
  }

  getEventForLead(leadId: number): Promise<ConversionEvent | null> {
    return this.events.findByLeadId(leadId);
  }

  listEvents(): Promise<ConversionEvent[]> {
    return this.events.findAll();
  }

  findDueForRetry(now: Date = new Date()): Promise<ConversionEvent[]> {
    return this.events.findDueForRetry(now);
  }

  checkTrackerConnectivity() {
    return trackerPing();
  }

  /**
   * Step 1 of the outbox pattern: persist the outbound event BEFORE attempting
   * to send it. One event per lead, so re-converting the same lead (or
   * retrying) always reuses the same row and the same event_id.
   *
   * The event_id is `conv_{lead_id}_{random}`, generated once and stored. A
   * bare `conv_{lead_id}` collides at the tracker whenever the DB is reset or
   * another environment shares the API key (lead ids restart at 1, and the
   * tracker then answers duplicate:true for a conversion it has never seen).
   */
  private async getOrCreateEvent(lead: Lead): Promise<ConversionEvent> {
    const existing = await this.events.findByLeadId(lead.id);
    if (existing) return existing;

    const eventId = `conv_${lead.id}_${randomUUID().slice(0, 8)}`;
    return this.events.createOrGetExisting({
      eventId,
      leadId: lead.id,
      requestBody: JSON.stringify(buildPayload(lead, eventId)),
    });
  }
}
