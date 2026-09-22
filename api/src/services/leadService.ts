import { prisma } from "../lib/prisma";
import { isLeadStatus, isSupportedCurrency, LeadStatus, SUPPORTED_CURRENCIES } from "../lib/constants";
import { HttpError, NotFoundError, ValidationError } from "../lib/errors";
import { dispatchConversionForLead } from "./conversionService";
import type { Lead } from "@prisma/client";

export interface CreateLeadInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  source?: unknown;
  amount?: unknown;
  currency?: unknown;
}

function normalizeString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Validation shared by create and (non-status) update. Does not enforce the
 * conversion-only rules (contact + amount) — those are checked separately in
 * changeStatus, since a lead is allowed to exist without them until it's
 * converted. */
function validateContactAndCurrency(input: {
  name?: string;
  email?: string;
  phone?: string;
  amount?: number;
  currency?: string;
}) {
  const errors: Record<string, string[]> = {};

  if (!input.name) {
    errors.name = ["name is required"];
  }
  if (!input.email && !input.phone) {
    errors.contact = ["email is required if phone is empty, and vice versa"];
  }
  if (input.currency && !isSupportedCurrency(input.currency)) {
    errors.currency = [`currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`];
  }
  if (input.amount !== undefined && (typeof input.amount !== "number" || Number.isNaN(input.amount))) {
    errors.amount = ["amount must be a number"];
  }
  // amount and currency travel together: a bare amount with no currency (or
  // vice versa) is accepted at creation time (both are only *required* once
  // you try to convert), but if you provide one you must provide both, since
  // a currency-less amount is meaningless downstream.
  if ((input.amount !== undefined) !== (input.currency !== undefined)) {
    errors.currency = [...(errors.currency ?? []), "amount and currency must be provided together"];
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError("validation_error", errors);
  }
}

export async function listLeads(filter: { status?: string; source?: string }) {
  const where: { status?: string; source?: string } = {};
  if (filter.status) {
    if (!isLeadStatus(filter.status)) {
      throw new ValidationError("validation_error", { status: [`unknown status: ${filter.status}`] });
    }
    where.status = filter.status;
  }
  if (filter.source) where.source = filter.source;

  return prisma.lead.findMany({ where, orderBy: { createdAt: "desc" } });
}

export async function getLead(id: number): Promise<Lead> {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) throw new NotFoundError(`lead ${id} not found`);
  return lead;
}

export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const name = normalizeString(input.name);
  const email = normalizeString(input.email);
  const phone = normalizeString(input.phone);
  const source = normalizeString(input.source);
  const currency = normalizeString(input.currency)?.toUpperCase();
  const amount =
    input.amount === undefined || input.amount === null ? undefined : Number(input.amount);

  validateContactAndCurrency({ name, email, phone, amount, currency });

  return prisma.lead.create({
    data: { name: name!, email, phone, source, amount, currency, status: "new" },
  });
}

export interface UpdateLeadInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  source?: unknown;
  amount?: unknown;
  currency?: unknown;
}

/** Generic field update. Deliberately does NOT accept `status` — status
 * changes are a dedicated action (changeStatus) with their own rules, per
 * the assignment's "not a generic update any field" requirement. */
export async function updateLead(id: number, input: UpdateLeadInput): Promise<Lead> {
  const existing = await getLead(id);

  const name = input.name === undefined ? existing.name : normalizeString(input.name);
  const email = input.email === undefined ? existing.email ?? undefined : normalizeString(input.email);
  const phone = input.phone === undefined ? existing.phone ?? undefined : normalizeString(input.phone);
  const source = input.source === undefined ? existing.source ?? undefined : normalizeString(input.source);
  const currency =
    input.currency === undefined
      ? existing.currency ?? undefined
      : normalizeString(input.currency)?.toUpperCase();
  const amount =
    input.amount === undefined
      ? existing.amount ?? undefined
      : input.amount === null
        ? undefined
        : Number(input.amount);

  validateContactAndCurrency({ name, email, phone, amount, currency });

  return prisma.lead.update({
    where: { id },
    data: { name: name!, email, phone, source, amount, currency },
  });
}

export async function deleteLead(id: number): Promise<void> {
  await getLead(id);
  const event = await prisma.conversionEvent.findUnique({ where: { leadId: id } });
  if (event) {
    throw new HttpError(409, "cannot delete a lead that has a conversion event (it would erase the delivery audit trail)");
  }
  await prisma.lead.delete({ where: { id } });
}

export interface ChangeStatusResult {
  lead: Lead;
  conversionEvent?: Awaited<ReturnType<typeof dispatchConversionForLead>>;
}

export async function changeStatus(id: number, newStatus: unknown): Promise<ChangeStatusResult> {
  if (!isLeadStatus(newStatus)) {
    throw new ValidationError("validation_error", {
      status: [`status must be one of: new, contacted, qualified, converted, lost`],
    });
  }

  const lead = await getLead(id);

  if (newStatus === "converted") {
    if (lead.status === "lost") {
      throw new HttpError(409, "cannot convert a lost lead");
    }
    const hasContact = Boolean(lead.email || lead.phone);
    const hasAmount = lead.amount !== null && lead.amount !== undefined;
    const hasCurrency = Boolean(lead.currency);
    if (!hasContact || !hasAmount || !hasCurrency) {
      throw new ValidationError("cannot convert lead: missing required fields", {
        contact: hasContact ? undefined : ["lead needs an email or phone before it can convert"],
        amount: hasAmount ? undefined : ["amount is required before conversion"],
        currency: hasCurrency ? undefined : ["currency is required before conversion"],
      });
    }
  }

  const updated = await prisma.lead.update({ where: { id }, data: { status: newStatus as LeadStatus } });

  if (newStatus === "converted") {
    const conversionEvent = await dispatchConversionForLead(updated);
    return { lead: updated, conversionEvent };
  }

  return { lead: updated };
}
