import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../src/domain/errors";
import { convertibleLead, createTestServices } from "./helpers/setup";

/** Runs `fn`, expects a ValidationError, and returns its field errors. */
async function validationErrors(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const err = await fn().then(
    () => {
      throw new Error("expected a ValidationError");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).details;
}

describe("LeadService.createLead", () => {
  it("creates a lead with status 'new'", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    expect(lead).toMatchObject({ id: 1, name: "Dana Cohen", status: "new", amount: 199.5, currency: "USD" });
  });

  it("requires a name", async () => {
    const { leadService } = createTestServices();
    expect(await validationErrors(() => leadService.createLead({ email: "a@b.co" }))).toHaveProperty("name");
  });

  it("requires an email or a phone — always, not only before conversion", async () => {
    const { leadService } = createTestServices();
    expect(await validationErrors(() => leadService.createLead({ name: "Dana" }))).toHaveProperty("contact");
    await expect(leadService.createLead({ name: "Dana", phone: "+972501234567" })).resolves.toBeDefined();
  });

  it("rejects an amount of 0 or less", async () => {
    const { leadService } = createTestServices();
    const errors = await validationErrors(() =>
      leadService.createLead({ name: "Dana", email: "a@b.co", amount: -5, currency: "USD" })
    );
    expect(errors).toHaveProperty("amount");
  });

  it("rejects a currency outside the supported list", async () => {
    const { leadService } = createTestServices();
    const errors = await validationErrors(() =>
      leadService.createLead({ name: "Dana", email: "a@b.co", amount: 5, currency: "ZZZ" })
    );
    expect(errors).toHaveProperty("currency");
  });

  it("requires amount and currency together", async () => {
    const { leadService } = createTestServices();
    expect(
      await validationErrors(() => leadService.createLead({ name: "Dana", email: "a@b.co", amount: 5 }))
    ).toHaveProperty("currency");
  });
});

describe("LeadService.updateLead", () => {
  it("keeps omitted fields and clears fields sent as null", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead({ ...convertibleLead, phone: "+972501234567" });

    const updated = await leadService.updateLead(lead.id, { email: null, source: "google" });

    expect(updated.email).toBeNull(); // cleared
    expect(updated.source).toBe("google"); // changed
    expect(updated.phone).toBe("+972501234567"); // omitted → kept
    expect(updated.name).toBe("Dana Cohen"); // omitted → kept
  });

  it("won't clear the last remaining contact", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead(convertibleLead); // email only
    expect(await validationErrors(() => leadService.updateLead(lead.id, { email: null }))).toHaveProperty("contact");
  });

  it("fails with NotFoundError for an unknown lead", async () => {
    const { leadService } = createTestServices();
    await expect(leadService.updateLead(999, { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("LeadService.changeStatus", () => {
  it("converting records a pending event — and does NOT call the tracker", async () => {
    const { leadService, tracker } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);

    const { lead: converted, conversionEvent } = await leadService.changeStatus(lead.id, "converted");

    expect(converted.status).toBe("converted");
    expect(conversionEvent).toMatchObject({ status: "pending", attempts: 0, leadId: lead.id });
    expect(conversionEvent?.eventId).toMatch(new RegExp(`^conv_${lead.id}_[0-9a-f]{8}$`));
    expect(conversionEvent?.payload).toMatchObject({
      event_id: conversionEvent?.eventId,
      event_name: "purchase",
      email: "dana@example.com",
      lead_id: String(lead.id),
      amount: 199.5,
      currency: "USD",
    });
    // Posting is the worker's job, never the HTTP request's.
    expect(tracker.sent).toHaveLength(0);
  });

  it("re-converting re-queues the same event (same event_id), so the tracker can dedupe it", async () => {
    const { leadService, events } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    const first = (await leadService.changeStatus(lead.id, "converted")).conversionEvent!;
    events.get(first.id).status = "sent"; // as if the worker had posted it

    const second = (await leadService.changeStatus(lead.id, "converted")).conversionEvent!;

    expect(second.eventId).toBe(first.eventId);
    expect(second.id).toBe(first.id); // no second row
    expect(second.status).toBe("pending");
  });

  it("refuses to convert without an amount and currency", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead({ name: "Dana", phone: "+972501234567" });
    const errors = await validationErrors(() => leadService.changeStatus(lead.id, "converted"));
    expect(errors.amount).toBeDefined();
    expect(errors.currency).toBeDefined();
  });

  it("refuses to convert a lost lead", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    await leadService.changeStatus(lead.id, "lost");
    await expect(leadService.changeStatus(lead.id, "converted")).rejects.toBeInstanceOf(ConflictError);
  });

  it("other status changes create no conversion event", async () => {
    const { leadService, events } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    const result = await leadService.changeStatus(lead.id, "contacted");
    expect(result.conversionEvent).toBeUndefined();
    expect(events.rows.size).toBe(0);
  });
});

describe("LeadService.deleteLead", () => {
  it("deletes a lead that was never converted", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    await leadService.deleteLead(lead.id);
    await expect(leadService.getLead(lead.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to delete a lead with a conversion event (it's the delivery audit trail)", async () => {
    const { leadService } = createTestServices();
    const lead = await leadService.createLead(convertibleLead);
    await leadService.changeStatus(lead.id, "converted");
    await expect(leadService.deleteLead(lead.id)).rejects.toBeInstanceOf(ConflictError);
  });
});
