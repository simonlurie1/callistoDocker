// Exponential backoff schedule for retrying failed conversion sends.
// Index 0 = delay before the 2nd attempt, etc. The last value repeats for
// any further attempts (capped backoff, retried indefinitely).
const SCHEDULE_SECONDS = [60, 5 * 60, 15 * 60];

export function nextRetryDelaySeconds(attemptsSoFar: number): number {
  const index = Math.min(attemptsSoFar - 1, SCHEDULE_SECONDS.length - 1);
  return SCHEDULE_SECONDS[Math.max(index, 0)];
}
