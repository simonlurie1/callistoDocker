import { isLeadStatus, LEAD_STATUSES, type LeadStatus } from "../lib/constants";
import type { LeadFieldsInput } from "../services/leadService";
import { RequestValidationError } from "./requestErrors";

// Turns raw request input into typed service input. Only shape and format
// live here; business rules (contact required, currency allowlist, ...) are
// enforced by LeadService.

// Pragmatic format check (not full RFC 5322): catches what the tracker
// rejects as "must be a valid email address" before the lead is saved,
// instead of the conversion failing permanently with a 422 later.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s\-()]{6,32}$/;

type Errors = Record<string, string[]>;
type Body = Record<string, unknown>;

/** undefined = field not sent; null = sent empty ("" or null), which clears it on update. */
function readText(body: Body, key: string, errors: Errors): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    errors[key] = [`${key} must be a string`];
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function readAmount(body: Body, errors: Errors): number | null | undefined {
  const value = body.amount;
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const amount = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(amount)) {
    errors.amount = ["amount must be a number"];
    return undefined;
  }
  return amount;
}

/** Parses a lead create/update body. Length limits mirror the DB columns so
 * oversized input is a 422, not a database error. */
export function parseLeadFields(rawBody: unknown): LeadFieldsInput {
  const body: Body =
    rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Body) : {};
  const errors: Errors = {};

  const name = readText(body, "name", errors);
  const email = readText(body, "email", errors);
  const phone = readText(body, "phone", errors);
  const source = readText(body, "source", errors);
  const rawCurrency = readText(body, "currency", errors);
  const currency = typeof rawCurrency === "string" ? rawCurrency.toUpperCase() : rawCurrency;
  const amount = readAmount(body, errors);

  if (name && name.length > 255) errors.name = ["name must be at most 255 characters"];
  if (email && (email.length > 255 || !EMAIL_RE.test(email))) {
    errors.email = ["email must be a valid email address"];
  }
  if (phone && !PHONE_RE.test(phone)) {
    errors.phone = ["phone must be 6-32 characters: digits, spaces, dashes, parentheses, optional leading +"];
  }
  if (source && source.length > 100) errors.source = ["source must be at most 100 characters"];

  if (Object.keys(errors).length > 0) throw new RequestValidationError(errors);
  return { name, email, phone, source, amount, currency };
}

export function parseStatus(value: unknown): LeadStatus {
  if (!isLeadStatus(value)) {
    throw new RequestValidationError({ status: [`status must be one of: ${LEAD_STATUSES.join(", ")}`] });
  }
  return value;
}

/** Optional ?status= filter; an empty value means "no filter". */
export function parseStatusFilter(value: unknown): LeadStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isLeadStatus(value)) {
    throw new RequestValidationError({ status: [`unknown status: ${String(value)}`] });
  }
  return value;
}
