import { Prisma, type PrismaClient } from "@prisma/client";
import type { ConversionEvent } from "../../domain/models";
import type {
  AttemptRecord,
  ConversionEventRepository,
  NewConversionEvent,
  PostingCriteria,
} from "../ConversionEventRepository";
import { toConversionEvent } from "./mappers";

/** Single definition of "needs posting", shared by the scan and the claim so
 * they can never disagree. `lt`/`lte` never match NULL, so a failed event
 * without a scheduled retry is excluded. */
function needsPosting({ now, staleBefore }: PostingCriteria): Prisma.ConversionEventWhereInput {
  return {
    OR: [
      { status: "pending" },
      { status: "failed", nextRetryAt: { lte: now } },
      { status: "in_process", processingStartedAt: { lt: staleBefore } },
    ],
  };
}

export class PrismaConversionEventRepository implements ConversionEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByLeadId(leadId: number): Promise<ConversionEvent | null> {
    const row = await this.prisma.conversionEvent.findUnique({ where: { leadId } });
    return row ? toConversionEvent(row) : null;
  }

  async findAll(): Promise<ConversionEvent[]> {
    const rows = await this.prisma.conversionEvent.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(toConversionEvent);
  }

  async createOrGetExisting(event: NewConversionEvent): Promise<ConversionEvent> {
    try {
      const row = await this.prisma.conversionEvent.create({
        data: {
          eventId: event.eventId,
          leadId: event.leadId,
          requestBody: JSON.stringify(event.payload),
          status: "pending",
          attempts: 0,
        },
      });
      return toConversionEvent(row);
    } catch (err) {
      // P2002 = unique violation on lead_id: another request inserted this
      // lead's event first. Only one insert can win, so use the winner's row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const row = await this.prisma.conversionEvent.findUniqueOrThrow({
          where: { leadId: event.leadId },
        });
        return toConversionEvent(row);
      }
      throw err;
    }
  }

  async requeue(id: number): Promise<ConversionEvent> {
    await this.prisma.conversionEvent.updateMany({
      where: { id, status: { in: ["sent", "failed"] } },
      data: { status: "pending", nextRetryAt: null },
    });
    return toConversionEvent(await this.prisma.conversionEvent.findUniqueOrThrow({ where: { id } }));
  }

  async findDueForPosting(criteria: PostingCriteria, limit: number): Promise<ConversionEvent[]> {
    const rows = await this.prisma.conversionEvent.findMany({
      where: needsPosting(criteria),
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map(toConversionEvent);
  }

  async claimForPosting(id: number, criteria: PostingCriteria): Promise<ConversionEvent | null> {
    // One conditional UPDATE: MySQL applies it atomically, so when several
    // workers race for the same row exactly one sees count = 1.
    const { count } = await this.prisma.conversionEvent.updateMany({
      where: { AND: [{ id }, needsPosting(criteria)] },
      data: { status: "in_process", processingStartedAt: criteria.now },
    });
    if (count === 0) return null;
    return toConversionEvent(await this.prisma.conversionEvent.findUniqueOrThrow({ where: { id } }));
  }

  async recordAttempt(id: number, attempt: AttemptRecord): Promise<ConversionEvent> {
    const row = await this.prisma.conversionEvent.update({
      where: { id },
      data: {
        status: attempt.status,
        attempts: { increment: 1 },
        responseStatus: attempt.responseStatus,
        responseBody: attempt.responseBody,
        lastError: attempt.lastError,
        lastAttemptAt: attempt.attemptedAt,
        nextRetryAt: attempt.nextRetryAt,
        processingStartedAt: null,
      },
    });
    return toConversionEvent(row);
  }
}
