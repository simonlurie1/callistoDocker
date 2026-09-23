import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackerResults } from "./helpers/fakeTracker";
import { convertibleLead, createTestServices } from "./helpers/setup";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const STALE_AFTER_MS = 5 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Creates `count` converted leads; each has a pending conversion event. */
async function pendingConversions(services: ReturnType<typeof createTestServices>, count: number) {
  const events = [];
  for (let i = 1; i <= count; i++) {
    const lead = await services.leadService.createLead({ ...convertibleLead, email: `lead${i}@example.com` });
    events.push((await services.leadService.changeStatus(lead.id, "converted")).conversionEvent!);
  }
  return events;
}

describe("ConversionBatchService.runOnce", () => {
  it("does nothing when nothing needs posting", async () => {
    const { batchService, tracker } = createTestServices();
    const result = await batchService.runOnce();
    expect(result.found).toBe(0);
    expect(tracker.sent).toHaveLength(0);
  });

  it("claims and posts every pending event exactly once", async () => {
    const services = createTestServices();
    const pending = await pendingConversions(services, 3);

    const result = await services.batchService.runOnce();

    expect(result.found).toBe(3);
    expect(result.posted.map((e) => e.status)).toEqual(["sent", "sent", "sent"]);
    expect(services.tracker.sent.map((p) => p.event_id)).toEqual(pending.map((e) => e.eventId));
  });

  it("takes at most batchSize events per pass, oldest first", async () => {
    const services = createTestServices({ batchSize: 2 });
    const pending = await pendingConversions(services, 3);

    const first = await services.batchService.runOnce();
    const second = await services.batchService.runOnce();

    expect(first.posted.map((e) => e.id)).toEqual([pending[0].id, pending[1].id]);
    expect(second.posted.map((e) => e.id)).toEqual([pending[2].id]);
  });

  describe("retries", () => {
    it("leaves a failed event alone until its retry is due, then posts it", async () => {
      const services = createTestServices();
      services.tracker.willRespond(trackerResults.serverError(60)); // retry in 60s
      await pendingConversions(services, 1);
      await services.batchService.runOnce(); // fails

      vi.setSystemTime(new Date(NOW.getTime() + 30_000));
      expect((await services.batchService.runOnce()).found).toBe(0); // not due yet

      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      const result = await services.batchService.runOnce(); // due now
      expect(result.posted[0]).toMatchObject({ status: "sent", attempts: 2 });
    });

    it("never picks up a permanently failed event (e.g. 401) again", async () => {
      const services = createTestServices();
      services.tracker.willRespond(trackerResults.unauthorized());
      await pendingConversions(services, 1);
      await services.batchService.runOnce();

      vi.setSystemTime(new Date(NOW.getTime() + 24 * 3600_000)); // a day later
      expect((await services.batchService.runOnce()).found).toBe(0);
    });
  });

  describe("crash recovery: events stuck in_process", () => {
    it("reclaims a claim older than staleAfterMs (its worker crashed mid-post)", async () => {
      const services = createTestServices({ staleAfterMs: STALE_AFTER_MS });
      const [event] = await pendingConversions(services, 1);
      Object.assign(services.events.get(event.id), {
        status: "in_process",
        processingStartedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1), // abandoned
      });

      const result = await services.batchService.runOnce();

      expect(result.posted[0]).toMatchObject({ id: event.id, status: "sent" });
    });

    it("leaves a fresh claim alone (another worker is posting it right now)", async () => {
      const services = createTestServices({ staleAfterMs: STALE_AFTER_MS });
      const [event] = await pendingConversions(services, 1);
      Object.assign(services.events.get(event.id), { status: "in_process", processingStartedAt: NOW });

      const result = await services.batchService.runOnce();

      expect(result.found).toBe(0);
      expect(services.tracker.sent).toHaveLength(0);
    });
  });

  it("repairs a lead left 'converted' with no conversion event, and posts it in the same pass", async () => {
    const services = createTestServices();
    const lead = await services.leadService.createLead(convertibleLead);
    // A crash between the two writes: status updated, event never created.
    await services.leads.updateStatus(lead.id, "converted");

    const result = await services.batchService.runOnce();

    expect(result.reconciledLeadIds).toEqual([lead.id]);
    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]).toMatchObject({ leadId: lead.id, status: "sent" });
  });

  it("an error on one event (e.g. the DB drops) doesn't stop the rest of the pass", async () => {
    const services = createTestServices();
    const [first, second] = await pendingConversions(services, 2);
    const recordAttempt = services.events.recordAttempt.bind(services.events);
    vi.spyOn(services.events, "recordAttempt").mockImplementation(async (id, ...rest) => {
      if (id === first.id) throw new Error("Can't reach database server");
      return recordAttempt(id, ...rest);
    });

    const result = await services.batchService.runOnce();

    expect(result.errors).toEqual([{ eventId: first.eventId, error: expect.any(Error) }]);
    expect(result.posted.map((e) => e.id)).toEqual([second.id]); // the second still went out
    // The first is left claimed; it's recovered once that claim goes stale.
    expect(services.events.get(first.id).status).toBe("in_process");
  });

  it("reports a lost claim when another worker took the event over mid-post", async () => {
    const services = createTestServices();
    const [event] = await pendingConversions(services, 1);
    vi.spyOn(services.conversionService, "attemptSend").mockResolvedValue(null);

    const result = await services.batchService.runOnce();

    expect(result.lostClaimEventIds).toEqual([event.eventId]);
    expect(result.posted).toHaveLength(0);
  });

  it("counts events another worker claimed first as skipped", async () => {
    const services = createTestServices();
    await pendingConversions(services, 2);
    vi.spyOn(services.events, "claimForPosting").mockResolvedValue(null);

    const result = await services.batchService.runOnce();

    expect(result.skipped).toBe(2);
    expect(services.tracker.sent).toHaveLength(0);
  });

  it("stops claiming new events once shutdown is requested", async () => {
    const services = createTestServices();
    await pendingConversions(services, 3);
    let calls = 0;

    const result = await services.batchService.runOnce(() => ++calls > 1); // stop after the first

    expect(result.posted).toHaveLength(1);
    expect(services.tracker.sent).toHaveLength(1);
  });

  it("two workers running at the same time post each event exactly once", async () => {
    const services = createTestServices();
    await pendingConversions(services, 10);
    const { ConversionBatchService } = await import("../src/services/conversionBatchService");
    const secondWorker = new ConversionBatchService(services.events, services.leads, services.conversionService, {
      batchSize: 10,
      staleAfterMs: STALE_AFTER_MS,
    });

    const [a, b] = await Promise.all([services.batchService.runOnce(), secondWorker.runOnce()]);

    const postedIds = [...a.posted, ...b.posted].map((e) => e.id).sort((x, y) => x - y);
    expect(postedIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // each once, none twice
    expect(a.skipped + b.skipped).toBe(10); // every event was contested and lost by one side
    expect(services.tracker.sent).toHaveLength(10);
  });
});
