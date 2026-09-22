import { isSupportedCurrency, SUPPORTED_CURRENCIES, type LeadStatus } from "../lib/constants";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors";
import type { ConversionEvent, Lead } from "../domain/models";
import type { LeadFields, LeadFilter, LeadRepository } from "../repositories/LeadRepository";
import type { ConversionService } from "./conversionService";

/** Lead field values from the caller: undefined = not provided, null = empty / cleared. */
export interface LeadFieldsInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  amount?: number | null;
  currency?: string | null;
}

export interface ChangeStatusResult {
  lead: Lead;
  conversionEvent?: ConversionEvent;
}

type LeadDraft = Omit<LeadFields, "name"> & { name: string | null };

/** The rules every lead must satisfy, whether just created or edited. The
 * conversion-only rules (amount required, etc.) live in changeStatus, since a
 * lead may exist without them until it's converted. */
function assertLeadRules(draft: LeadDraft): asserts draft is LeadFields {
  const errors: Record<string, string[]> = {};

  if (!draft.name) {
    errors.name = ["name is required"];
  }
  if (!draft.email && !draft.phone) {
    errors.contact = ["email is required if phone is empty, and vice versa"];
  }
  if (draft.amount !== null && draft.amount <= 0) {
    errors.amount = ["amount must be greater than 0"];
  }
  if (draft.currency && !isSupportedCurrency(draft.currency)) {
    errors.currency = [`currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`];
  }
  // A bare amount without a currency (or vice versa) is meaningless, so
  // they're set together — though neither is required until conversion.
  if ((draft.amount !== null) !== (draft.currency !== null)) {
    errors.currency = [...(errors.currency ?? []), "amount and currency must be provided together"];
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError("validation_error", errors);
  }
}

export class LeadService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly conversions: ConversionService
  ) {}

  listLeads(filter: LeadFilter): Promise<Lead[]> {
    return this.leads.findMany(filter);
  }

  async getLead(id: number): Promise<Lead> {
    const lead = await this.leads.findById(id);
    if (!lead) throw new NotFoundError(`lead ${id} not found`);
    return lead;
  }

  async createLead(input: LeadFieldsInput): Promise<Lead> {
    const draft: LeadDraft = {
      name: input.name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: input.source ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
    };
    assertLeadRules(draft);
    return this.leads.create(draft);
  }

  /** Generic field update. Deliberately has no `status` — status changes are
   * a dedicated action (changeStatus) with their own rules. Omitted fields
   * keep their value, null clears; the merged result must still satisfy the
   * lead rules (so e.g. the last contact can't be cleared). */
  async updateLead(id: number, input: LeadFieldsInput): Promise<Lead> {
    const existing = await this.getLead(id);
    const merge = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);

    const draft: LeadDraft = {
      name: merge<string | null>(input.name, existing.name),
      email: merge(input.email, existing.email),
      phone: merge(input.phone, existing.phone),
      source: merge(input.source, existing.source),
      amount: merge(input.amount, existing.amount),
      currency: merge(input.currency, existing.currency),
    };
    assertLeadRules(draft);
    return this.leads.update(id, draft);
  }

  /** A lead with a conversion event is kept: deleting it would erase the
   * delivery audit trail. */
  async deleteLead(id: number): Promise<void> {
    await this.getLead(id);
    if (await this.conversions.getEventForLead(id)) {
      throw new ConflictError(
        "cannot delete a lead that has a conversion event (it would erase the delivery audit trail)"
      );
    }
    await this.leads.delete(id);
  }

  async changeStatus(id: number, newStatus: LeadStatus): Promise<ChangeStatusResult> {
    const lead = await this.getLead(id);

    if (newStatus === "converted") {
      if (lead.status === "lost") {
        throw new ConflictError("cannot convert a lost lead");
      }
      const hasContact = Boolean(lead.email || lead.phone);
      const hasAmount = lead.amount !== null;
      const hasCurrency = Boolean(lead.currency);
      if (!hasContact || !hasAmount || !hasCurrency) {
        throw new ValidationError("cannot convert lead: missing required fields", {
          contact: hasContact ? undefined : ["lead needs an email or phone before it can convert"],
          amount: hasAmount ? undefined : ["amount is required before conversion"],
          currency: hasCurrency ? undefined : ["currency is required before conversion"],
        });
      }
    }

    const updated = await this.leads.updateStatus(id, newStatus);

    if (newStatus === "converted") {
      const conversionEvent = await this.conversions.dispatchForLead(updated);
      return { lead: updated, conversionEvent };
    }

    return { lead: updated };
  }
}
