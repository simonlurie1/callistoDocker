import { randomUUID } from "crypto";
import type { ConversionEvent, ConversionPayload, Lead } from "../domain/models";
import type { ConversionEventRepository } from "../repositories/ConversionEventRepository";
import type { ConversionTracker } from "../tracker/ConversionTracker";
import { nextRetryDelaySeconds } from "../lib/backoff";

// The event_id is `conv_{lead_id}_{random}`, generated once per lead and
// reused for every post of that conversion. A bare `conv_{lead_id}` collides
// at the tracker whenever the DB is reset or another environment shares the
// API key (lead ids restart at 1, and the tracker then answers duplicate:true
// for a conversion it has never seen).
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
  constructor(
    private readonly events: ConversionEventRepository,
    private readonly tracker: ConversionTracker
  ) {}

  /**
   * Called when a lead's status becomes "converted". Only records the
   * conversion as a pending event — posting it is the batch service's job
   * (ConversionBatchService, run by the worker).
   *
   * Re-converting an already-converted lead re-queues its existing event, so
   * the same event_id is posted again and the tracker answers duplicate:true
   * instead of counting it twice. An event that is already pending or being
   * posted is left as is.
   */
  async recordConversion(lead: Lead): Promise<ConversionEvent> {
    const existing = await this.events.findByLeadId(lead.id);
    if (existing) return this.events.requeue(existing.id);

    const eventId = `conv_${lead.id}_${randomUUID().slice(0, 8)}`;
    return this.events.createOrGetExisting({
      eventId,
      leadId: lead.id,
      payload: buildPayload(lead, eventId),
    });
  }

  /** Posts an event the caller has claimed, and records the outcome on it. */
  async attemptSend(event: ConversionEvent): Promise<ConversionEvent> {
    const result = await this.tracker.send(event.payload);
    const delivered = result.outcome === "accepted" || result.outcome === "duplicate";
    const retry = result.outcome === "retryable_failure";

    return this.events.recordAttempt(event.id, {
      status: delivered ? "sent" : "failed",
      responseStatus: result.httpStatus,
      responseBody: result.responseBody,
      lastError: result.error,
      attemptedAt: new Date(),
      nextRetryAt: retry
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
}
