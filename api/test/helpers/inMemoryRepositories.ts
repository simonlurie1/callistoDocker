import type { ConversionEvent, Lead } from "../../src/domain/models";
import type { LeadStatus } from "../../src/lib/constants";
import type {
  AttemptRecord,
  ConversionEventRepository,
  NewConversionEvent,
  PostingCriteria,
} from "../../src/repositories/ConversionEventRepository";
import type { LeadFields, LeadFilter, LeadRepository } from "../../src/repositories/LeadRepository";

// In-memory implementations of the repository interfaces. This is the payoff
// of the repository pattern: the services under test can't tell these apart
// from the Prisma ones, so the tests need no database and no Docker.
//
// They return copies (structuredClone), like a real database would, so a test
// can't accidentally pass by mutating an object the "database" also holds.

export class InMemoryConversionEventRepository implements ConversionEventRepository {
  readonly rows = new Map<number, ConversionEvent>();
  private nextId = 1;

  hasEventForLead(leadId: number): boolean {
    return [...this.rows.values()].some((event) => event.leadId === leadId);
  }

  async findByLeadId(leadId: number): Promise<ConversionEvent | null> {
    const event = [...this.rows.values()].find((row) => row.leadId === leadId);
    return event ? structuredClone(event) : null;
  }

  async findAll(): Promise<ConversionEvent[]> {
    return [...this.rows.values()].sort((a, b) => b.id - a.id).map((row) => structuredClone(row));
  }

  async createOrGetExisting(event: NewConversionEvent): Promise<ConversionEvent> {
    const existing = await this.findByLeadId(event.leadId);
    if (existing) return existing;
    const now = new Date();
    const row: ConversionEvent = {
      id: this.nextId++,
      eventId: event.eventId,
      leadId: event.leadId,
      status: "pending",
      attempts: 0,
      payload: event.payload,
      responseStatus: null,
      responseBody: null,
      lastError: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      processingStartedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async requeue(id: number): Promise<ConversionEvent> {
    const row = this.get(id);
    if (row.status === "sent" || row.status === "failed") {
      row.status = "pending";
      row.nextRetryAt = null;
    }
    return structuredClone(row);
  }

  async findDueForPosting(criteria: PostingCriteria, limit: number): Promise<ConversionEvent[]> {
    return [...this.rows.values()]
      .filter((row) => needsPosting(row, criteria))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async claimForPosting(id: number, criteria: PostingCriteria): Promise<ConversionEvent | null> {
    // No await between the check and the write, so — JavaScript being
    // single-threaded — this is atomic, like the conditional UPDATE in MySQL.
    const row = this.get(id);
    if (!needsPosting(row, criteria)) return null;
    row.status = "in_process";
    row.processingStartedAt = criteria.now;
    return structuredClone(row);
  }

  async recordAttempt(id: number, claimedAt: Date, attempt: AttemptRecord): Promise<ConversionEvent | null> {
    const row = this.get(id);
    // The fencing check: only the current claim holder may record.
    if (row.processingStartedAt?.getTime() !== claimedAt.getTime()) return null;
    row.status = attempt.status;
    row.attempts += 1;
    row.responseStatus = attempt.responseStatus;
    row.responseBody = attempt.responseBody;
    row.lastError = attempt.lastError;
    row.lastAttemptAt = attempt.attemptedAt;
    row.nextRetryAt = attempt.nextRetryAt;
    row.processingStartedAt = null;
    return structuredClone(row);
  }

  /** Test-only: direct access to a stored row, to set up or inspect state. */
  get(id: number): ConversionEvent {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no conversion event ${id}`);
    return row;
  }
}

function needsPosting(row: ConversionEvent, { now, staleBefore }: PostingCriteria): boolean {
  if (row.status === "pending") return true;
  if (row.status === "failed") return row.nextRetryAt !== null && row.nextRetryAt <= now;
  if (row.status === "in_process") return row.processingStartedAt !== null && row.processingStartedAt < staleBefore;
  return false;
}

export class InMemoryLeadRepository implements LeadRepository {
  readonly rows = new Map<number, Lead>();
  private nextId = 1;

  /** `events` lets findConvertedWithoutEvent see which leads have an event. */
  constructor(private readonly events: InMemoryConversionEventRepository) {}

  async findMany(filter: LeadFilter): Promise<Lead[]> {
    return [...this.rows.values()]
      .filter((lead) => (filter.status ? lead.status === filter.status : true))
      .filter((lead) => (filter.source ? lead.source === filter.source : true))
      .sort((a, b) => b.id - a.id)
      .map((lead) => structuredClone(lead));
  }

  async findById(id: number): Promise<Lead | null> {
    const lead = this.rows.get(id);
    return lead ? structuredClone(lead) : null;
  }

  async findConvertedWithoutEvent(): Promise<Lead[]> {
    return [...this.rows.values()]
      .filter((lead) => lead.status === "converted" && !this.events.hasEventForLead(lead.id))
      .map((lead) => structuredClone(lead));
  }

  async create(fields: LeadFields): Promise<Lead> {
    const now = new Date();
    const lead: Lead = { id: this.nextId++, ...fields, status: "new", createdAt: now, updatedAt: now };
    this.rows.set(lead.id, lead);
    return structuredClone(lead);
  }

  async update(id: number, fields: LeadFields): Promise<Lead> {
    const lead = { ...this.get(id), ...fields, updatedAt: new Date() };
    this.rows.set(id, lead);
    return structuredClone(lead);
  }

  async updateStatus(id: number, status: LeadStatus): Promise<Lead> {
    const lead = { ...this.get(id), status, updatedAt: new Date() };
    this.rows.set(id, lead);
    return structuredClone(lead);
  }

  async delete(id: number): Promise<void> {
    this.rows.delete(id);
  }

  /** Test-only: direct access to a stored row. */
  get(id: number): Lead {
    const lead = this.rows.get(id);
    if (!lead) throw new Error(`no lead ${id}`);
    return lead;
  }
}
