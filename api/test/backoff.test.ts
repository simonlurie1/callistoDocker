import { describe, expect, it } from "vitest";
import { MAX_RETRY_DELAY_SECONDS, nextRetryDelaySeconds } from "../src/lib/backoff";

// nextRetryDelaySeconds takes the random source as a parameter, so a test can
// pin it: random() = 0.5 lands exactly on the base delay (no jitter).
const noJitter = () => 0.5;

describe("nextRetryDelaySeconds", () => {
  it("follows the schedule 10s → 30s → 2m → 10m → 30m → 1h", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => nextRetryDelaySeconds(attempt, noJitter));
    expect(delays).toEqual([10, 30, 120, 600, 1800, 3600]);
  });

  it("stays capped at 1 hour for any later attempt", () => {
    expect(nextRetryDelaySeconds(7, noJitter)).toBe(3600);
    expect(nextRetryDelaySeconds(500, noJitter)).toBe(3600);
    expect(MAX_RETRY_DELAY_SECONDS).toBe(3600);
  });

  it("adds ±20% jitter so events that failed together don't retry together", () => {
    // toBeCloseTo, not toBe: 10 * 1.2 is 12.000000000000002 in floating point.
    expect(nextRetryDelaySeconds(1, () => 0)).toBeCloseTo(8); // 10s - 20%
    expect(nextRetryDelaySeconds(1, () => 1)).toBeCloseTo(12); // 10s + 20%
  });

  it("stays within the jitter bounds with real randomness", () => {
    for (let i = 0; i < 1000; i++) {
      const delay = nextRetryDelaySeconds(2);
      expect(delay).toBeGreaterThanOrEqual(24);
      expect(delay).toBeLessThanOrEqual(36);
    }
  });

  it("treats attempt 0 like the first attempt", () => {
    expect(nextRetryDelaySeconds(0, noJitter)).toBe(10);
  });
});
