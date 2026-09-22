import { Prisma, type PrismaClient } from "@prisma/client";
import type { ConversionEvent } from "../../domain/models";
import type {
  AttemptRecord,
  ConversionEventRepository,
  NewConversionEvent,
} from "../ConversionEventRepository";
import { toConversionEvent } from "./mappers";

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
        data: { ...event, status: "pending", attempts: 0 },
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
      },
    });
    return toConversionEvent(row);
  }

  async findDueForRetry(now: Date): Promise<ConversionEvent[]> {
    const rows = await this.prisma.conversionEvent.findMany({
      where: {
        OR: [
          { status: "pending" },
          // `lte` never matches NULL, so non-retryable failures are excluded
          { status: "failed", nextRetryAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toConversionEvent);
  }
}
