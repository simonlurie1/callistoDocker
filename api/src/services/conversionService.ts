import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { ping as trackerPing, postConversion, ConversionPayload } from "../lib/trackerClient";
import { nextRetryDelaySeconds } from "../lib/backoff";
import { Prisma } from "@prisma/client";
import type { ConversionEvent, Lead } from "@prisma/client";

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

/**
 * Step 1 of the outbox pattern: persist the outbound event BEFORE attempting
 * to send it. One event per lead (lead_id is unique), so re-converting the
 * same lead (or retrying) always reuses the same row and the same event_id.
 *
 * The event_id is `conv_{lead_id}_{random}`, generated once and stored. A
 * bare `conv_{lead_id}` collides at the tracker whenever the DB is reset or
 * another environment shares the API key (lead ids restart at 1, and the
 * tracker then answers duplicate:true for a conversion it has never seen).
 */
async function getOrCreateEvent(lead: Lead): Promise<ConversionEvent> {
  const existing = await prisma.conversionEvent.findUnique({ where: { leadId: lead.id } });
  if (existing) return existing;

  const eventId = `conv_${lead.id}_${randomUUID().slice(0, 8)}`;
  const payload = buildPayload(lead, eventId);
  try {
    return await prisma.conversionEvent.create({
      data: {
        eventId,
        leadId: lead.id,
        status: "pending",
        attempts: 0,
        requestBody: JSON.stringify(payload),
      },
    });
  } catch (err) {
    // Two concurrent converts of the same lead (double-click) can both miss
    // the findUnique above; the unique lead_id lets only one insert win, so
    // the loser just uses the winner's row (and its event_id).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.conversionEvent.findUniqueOrThrow({ where: { leadId: lead.id } });
    }
    throw err;
  }
}

/**
 * Step 2: actually send the persisted event, and record exactly what came
 * back (or what went wrong) on the same row.
 */
export async function attemptSend(event: ConversionEvent): Promise<ConversionEvent> {
  const payload = JSON.parse(event.requestBody) as ConversionPayload;
  const attempts = event.attempts + 1;
  const result = await postConversion(payload);

  const isNetworkFailure = result.httpStatus === 0;
  const isServerError = result.httpStatus >= 500;
  // 429 (the tracker's 30 req/min limit) and 408 are transient, like a 5xx.
  const isTransientClientError = result.httpStatus === 429 || result.httpStatus === 408;
  const bodyObj = result.body as { duplicate?: boolean } | null;
  const isSuccess =
    result.httpStatus === 201 || (result.httpStatus === 200 && bodyObj?.duplicate === true);

  const retryable = isNetworkFailure || isServerError || isTransientClientError;

  return prisma.conversionEvent.update({
    where: { id: event.id },
    data: {
      status: isSuccess ? "sent" : "failed",
      // Atomic increment: concurrent sends of the same event (double-click,
      // or a manual convert racing the retry command) must not lose a count.
      attempts: { increment: 1 },
      responseStatus: result.httpStatus,
      responseBody:
        typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? null),
      lastError: isSuccess ? null : result.networkError ?? null,
      lastAttemptAt: new Date(),
      nextRetryAt: !isSuccess && retryable
        ? new Date(Date.now() + nextRetryDelaySeconds(attempts) * 1000)
        : null,
    },
  });
}

/**
 * Entry point called right after a lead's status transitions to "converted"
 * (including re-converting an already-converted lead, which is how the
 * tracker's own idempotency gets exercised: same event_id, tracker replies
 * 200 duplicate:true instead of creating a second conversion). Persists the
 * event first (if it doesn't already exist), then makes one immediate send
 * attempt. If that attempt fails with a retryable error, the row is left
 * for the retry worker (npm run process-conversions) to pick up later.
 */
export async function dispatchConversionForLead(lead: Lead): Promise<ConversionEvent> {
  const event = await getOrCreateEvent(lead);
  return attemptSend(event);
}

export async function checkTrackerConnectivity() {
  return trackerPing();
}
