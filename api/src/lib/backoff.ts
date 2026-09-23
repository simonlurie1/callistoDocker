// Exponential backoff schedule for retrying failed conversion sends.
// Index 0 = delay before the 2nd attempt, etc. The last value repeats for
// any further attempts (capped backoff, retried indefinitely). Short steps
// first so a brief tracker blip recovers in seconds; capped at an hour so a
// long outage doesn't hammer the tracker (30 req/min per key).
const SCHEDULE_SECONDS = [10, 30, 2 * 60, 10 * 60, 30 * 60, 60 * 60];

/** ±20%, so events that failed together (e.g. during an outage) don't all
 * retry in the same instant when it ends. */
const JITTER = 0.2;

/** Upper bound for a tracker-supplied Retry-After, so a bogus header can't
 * park an event for days. */
export const MAX_RETRY_DELAY_SECONDS = SCHEDULE_SECONDS[SCHEDULE_SECONDS.length - 1];

export function nextRetryDelaySeconds(attemptsSoFar: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attemptsSoFar - 1, 0), SCHEDULE_SECONDS.length - 1);
  const base = SCHEDULE_SECONDS[index];
  return base * (1 - JITTER + 2 * JITTER * random());
}
