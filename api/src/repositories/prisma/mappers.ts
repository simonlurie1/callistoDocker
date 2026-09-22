import type { ConversionEvent as ConversionEventRow, Lead as LeadRow } from "@prisma/client";
import type { ConversionEvent, ConversionEventStatus, ConversionPayload, Lead } from "../../domain/models";
import type { LeadStatus } from "../../lib/constants";

// `status` columns are plain VARCHARs (see schema.prisma), so Prisma types
// them as string; the services only ever write valid values.

export function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    status: row.status as LeadStatus,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toConversionEvent(row: ConversionEventRow): ConversionEvent {
  return {
    id: row.id,
    eventId: row.eventId,
    leadId: row.leadId,
    status: row.status as ConversionEventStatus,
    attempts: row.attempts,
    // request_body is a TEXT column holding the payload as JSON
    payload: JSON.parse(row.requestBody) as ConversionPayload,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt,
    nextRetryAt: row.nextRetryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
