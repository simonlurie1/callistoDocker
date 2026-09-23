import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackerResults } from "./helpers/fakeTracker";
import { convertibleLead, createTestServices } from "./helpers/setup";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const secondsFromNow = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

beforeEach(() => {
  // Freeze the clock so retry times can be compared exactly, and pin the
  // backoff jitter to 0.5 (= no jitter).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A converted lead whose event has been claimed, as the batch service would. */
async function claimedEvent(services = createTestServices()) {
  const lead = await services.leadService.createLead(convertibleLead);
  const recorded = (await services.leadService.changeStatus(lead.id, "converted")).conversionEvent!;
  const claimed = await services.events.claimForPosting(recorded.id, { now: new Date(), staleBefore: new Date(0) });
  return { ...services, claimed: claimed! };
}

describe("ConversionService.attemptSend", () => {
  it("accepted (201) → sent, one attempt, claim released, no retry", async () => {
    const { conversionService, claimed, tracker } = await claimedEvent();

    const result = await conversionService.attemptSend(claimed);

    expect(tracker.sent).toEqual([claimed.payload]); // posted exactly the persisted payload
    expect(result).toMatchObject({
      status: "sent",
      attempts: 1,
      responseStatus: 201,
      nextRetryAt: null,
      processingStartedAt: null,
    });
  });

  it("duplicate (200 duplicate:true) counts as success", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.duplicate());
    const { conversionService, claimed } = await claimedEvent(services);

    expect(await conversionService.attemptSend(claimed)).toMatchObject({ status: "sent", responseStatus: 200 });
  });

  it("server error → failed, retry scheduled on the backoff schedule (10s for the first failure)", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.serverError());
    const { conversionService, claimed } = await claimedEvent(services);

    const result = await conversionService.attemptSend(claimed);

    expect(result).toMatchObject({ status: "failed", responseStatus: 500, nextRetryAt: secondsFromNow(10) });
  });

  it("each further failure waits longer (2nd failure: 30s)", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.serverError(), trackerResults.serverError());
    const { conversionService, events, claimed } = await claimedEvent(services);
    await conversionService.attemptSend(claimed);

    vi.setSystemTime(secondsFromNow(10)); // the retry comes due
    const reclaimed = await events.claimForPosting(claimed.id, { now: new Date(), staleBefore: new Date(0) });
    const result = await conversionService.attemptSend(reclaimed!);

    expect(result?.attempts).toBe(2);
    expect(result?.nextRetryAt).toEqual(new Date(new Date().getTime() + 30_000));
  });

  it("the tracker's Retry-After wins over the backoff schedule", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.serverError(120));
    const { conversionService, claimed } = await claimedEvent(services);

    expect((await conversionService.attemptSend(claimed))?.nextRetryAt).toEqual(secondsFromNow(120));
  });

  it("an absurd Retry-After is capped at 1 hour", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.serverError(10 * 24 * 3600)); // "come back in 10 days"
    const { conversionService, claimed } = await claimedEvent(services);

    expect((await conversionService.attemptSend(claimed))?.nextRetryAt).toEqual(secondsFromNow(3600));
  });

  it("no response at all (network down / timeout) → failed, error recorded, retry scheduled", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.noResponse("The operation was aborted due to timeout"));
    const { conversionService, claimed } = await claimedEvent(services);

    expect(await conversionService.attemptSend(claimed)).toMatchObject({
      status: "failed",
      responseStatus: null,
      lastError: "The operation was aborted due to timeout",
      nextRetryAt: secondsFromNow(10),
    });
  });

  it("permanent failure (401) → failed with NO retry, so it waits for a human", async () => {
    const services = createTestServices();
    services.tracker.willRespond(trackerResults.unauthorized());
    const { conversionService, claimed } = await claimedEvent(services);

    expect(await conversionService.attemptSend(claimed)).toMatchObject({
      status: "failed",
      responseStatus: 401,
      nextRetryAt: null,
    });
  });

  it("refuses to post an event that wasn't claimed", async () => {
    const { conversionService, leadService } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    const pending = (await leadService.changeStatus(lead.id, "converted")).conversionEvent!;

    await expect(conversionService.attemptSend(pending)).rejects.toThrow(/unclaimed/);
  });

  it("returns null (and writes nothing) if another worker took over the claim mid-post", async () => {
    const { conversionService, events, claimed } = await claimedEvent();
    // While this worker's post is "in flight", its claim goes stale and a
    // second worker reclaims the event: processingStartedAt changes.
    const secondWorkersClaim = new Date(NOW.getTime() + 60_000);
    events.get(claimed.id).processingStartedAt = secondWorkersClaim;

    const result = await conversionService.attemptSend(claimed);

    expect(result).toBeNull(); // fenced out
    expect(events.get(claimed.id)).toMatchObject({
      status: "in_process",
      attempts: 0, // the first worker's attempt wasn't recorded over the second's claim
      processingStartedAt: secondWorkersClaim,
    });
  });
});
