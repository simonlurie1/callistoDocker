import { describe, expect, it } from "vitest";
import { parseLeadFields, parseStatus, parseStatusFilter } from "../src/routes/leadRequests";
import { RequestValidationError } from "../src/routes/requestErrors";

/** Runs `fn`, expects a RequestValidationError, and returns its field errors. */
function validationErrors(fn: () => unknown): Record<string, string[]> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RequestValidationError);
    return (err as RequestValidationError).details;
  }
  throw new Error("expected a RequestValidationError");
}

describe("parseLeadFields", () => {
  it("trims text, uppercases the currency and parses a numeric-string amount", () => {
    expect(
      parseLeadFields({ name: "  Dana  ", email: " dana@example.com ", amount: "199.50", currency: "usd" })
    ).toEqual({
      name: "Dana",
      email: "dana@example.com",
      phone: undefined,
      source: undefined,
      amount: 199.5,
      currency: "USD",
    });
  });

  it('distinguishes "not sent" (undefined) from "sent empty" (null, which clears on update)', () => {
    const parsed = parseLeadFields({ email: "", phone: null, amount: "" });
    expect(parsed.name).toBeUndefined(); // not in the body
    expect(parsed.email).toBeNull(); // ""
    expect(parsed.phone).toBeNull(); // null
    expect(parsed.amount).toBeNull(); // ""
  });

  it("rejects a malformed email", () => {
    expect(validationErrors(() => parseLeadFields({ email: "not-an-email" }))).toHaveProperty("email");
  });

  it("rejects a phone that's too long or contains letters", () => {
    expect(validationErrors(() => parseLeadFields({ phone: "1".repeat(40) }))).toHaveProperty("phone");
    expect(validationErrors(() => parseLeadFields({ phone: "abc-def-ghij" }))).toHaveProperty("phone");
  });

  it("rejects a non-numeric amount and a non-text field", () => {
    const errors = validationErrors(() => parseLeadFields({ amount: "12abc", name: { first: "Dana" } }));
    expect(errors).toHaveProperty("amount");
    expect(errors).toHaveProperty("name");
  });

  it("treats a non-object body as empty (the business rules then reject it)", () => {
    expect(parseLeadFields("just a string")).toEqual({
      name: undefined,
      email: undefined,
      phone: undefined,
      source: undefined,
      amount: undefined,
      currency: undefined,
    });
  });

  it("leaves business rules to the service: no contact or an unknown currency parse fine here", () => {
    expect(() => parseLeadFields({ name: "Dana", currency: "ZZZ" })).not.toThrow();
  });
});

describe("parseStatus / parseStatusFilter", () => {
  it("accepts every known status", () => {
    for (const status of ["new", "contacted", "qualified", "converted", "lost"]) {
      expect(parseStatus(status)).toBe(status);
    }
  });

  it("rejects an unknown status", () => {
    expect(validationErrors(() => parseStatus("bogus"))).toHaveProperty("status");
  });

  it("treats a missing or empty filter as no filter", () => {
    expect(parseStatusFilter(undefined)).toBeUndefined();
    expect(parseStatusFilter("")).toBeUndefined();
    expect(validationErrors(() => parseStatusFilter("bogus"))).toHaveProperty("status");
  });
});
