import type { ConversionEvent } from "../domain/models";
import { errorDetails, logger } from "../lib/logger";
import type { BatchResult } from "../services/conversionBatchService";

/** Logs a batch pass's result — shared by the scheduled worker and the
 * one-off `process-conversions` command, so both are logged identically.
 * Runs inside the pass's logContext, so every line carries its passId.
 * `idleLevel` is the level for a pass that found nothing to do: the worker
 * passes "debug", since it runs every few seconds. */
export function logBatchResult(result: BatchResult, idleLevel: "debug" | "info" = "info"): void {
  for (const leadId of result.reconciledLeadIds) {
    logger.warn(`lead ${leadId} was "converted" with no conversion event — created the missing pending event`, {
      leadId,
    });
  }
  for (const { leadId, error } of result.reconcileErrors) {
    logger.error(`lead ${leadId}: failed to create its missing conversion event, will retry next pass`, {
      leadId,
      error: errorDetails(error),
    });
  }

  result.posted.forEach(logOutcome);

  for (const eventId of result.lostClaimEventIds) {
    logger.warn(
      `event ${eventId}: posted, but its claim went stale and another worker took it over before the outcome ` +
        `was recorded — no data lost, the new owner records its own outcome`,
      { eventId }
    );
  }
  for (const { eventId, error } of result.errors) {
    logger.error(`event ${eventId}: error during this pass (database or tracker), left for a later pass`, {
      eventId,
      error: errorDetails(error),
    });
  }

  const sent = result.posted.filter((event) => event.status === "sent").length;
  const summary = {
    found: result.found,
    attempted: result.posted.length,
    sent,
    failed: result.posted.length - sent,
    skippedClaimedElsewhere: result.skipped,
    lostClaims: result.lostClaimEventIds.length,
    errors: result.errors.length,
    reconciled: result.reconciledLeadIds.length,
  };
  const idle = result.found === 0 && result.reconciledLeadIds.length === 0;
  logger.log(
    result.errors.length + result.reconcileErrors.length > 0 ? "warn" : idle ? idleLevel : "info",
    idle
      ? "batch pass finished: no conversion events need posting"
      : `batch pass finished: ${summary.attempted} attempted (${summary.sent} sent, ${summary.failed} failed), ` +
          `${summary.errors} errored, ${summary.skippedClaimedElsewhere} claimed by another worker`,
    { batch: summary }
  );
}

function logOutcome(event: ConversionEvent): void {
  const meta = {
    eventId: event.eventId,
    leadId: event.leadId,
    status: event.status,
    attempts: event.attempts,
    httpStatus: event.responseStatus,
    nextRetryAt: event.nextRetryAt,
  };
  if (event.status === "sent") {
    logger.info(`event ${event.eventId}: sent (attempt #${event.attempts}, http ${event.responseStatus})`, meta);
  } else if (event.nextRetryAt) {
    logger.warn(
      `event ${event.eventId}: failed (attempt #${event.attempts}, http ${event.responseStatus ?? "none"}), ` +
        `retry at ${event.nextRetryAt.toISOString()}`,
      meta
    );
  } else if (event.responseStatus === 401) {
    // A bad API key fails every conversion, not just this one — called out
    // distinctly so it doesn't read like a single bad record.
    logger.error(
      `event ${event.eventId}: tracker rejected the API key (401) — check TRACKER_API_KEY; ` +
        `every conversion will fail until it's fixed. Not retried.`,
      meta
    );
  } else {
    logger.error(
      `event ${event.eventId}: permanent failure (http ${event.responseStatus ?? "none"}), will not be retried — needs a human`,
      meta
    );
  }
}
