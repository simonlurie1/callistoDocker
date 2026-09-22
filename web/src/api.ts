import type { ApiError, ConversionEvent, Lead } from "./types";

// All calls are same-origin relative paths. In dev, Vite proxies them to
// the local api (vite.config.ts); in Docker/prod, nginx reverse-proxies
// them to the api container (web/nginx.conf). The React app never needs
// to know the api's actual host/port.

export interface CreateLeadInput {
  name: string;
  email?: string;
  phone?: string;
  source?: string;
  amount?: number;
  currency?: string;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) {
    throw body as ApiError;
  }
  return body as T;
}

export async function fetchLeads(filter: { status?: string; source?: string }): Promise<Lead[]> {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.source) params.set("source", filter.source);
  const qs = params.toString();
  const res = await fetch(`/leads${qs ? `?${qs}` : ""}`);
  const body = await parseJsonOrThrow<{ data: Lead[] }>(res);
  return body.data;
}

export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const res = await fetch("/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await parseJsonOrThrow<{ data: Lead }>(res);
  return body.data;
}

export async function changeLeadStatus(
  id: number,
  status: string
): Promise<{ lead: Lead; conversionEvent?: ConversionEvent }> {
  const res = await fetch(`/leads/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const body = await parseJsonOrThrow<{ data: Lead; conversionEvent?: ConversionEvent }>(res);
  return { lead: body.data, conversionEvent: body.conversionEvent };
}

export async function deleteLead(id: number): Promise<void> {
  const res = await fetch(`/leads/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json();
    throw body as ApiError;
  }
}

export async function fetchConversionEvent(leadId: number): Promise<ConversionEvent | null> {
  const res = await fetch(`/leads/${leadId}/conversion-event`);
  if (res.status === 404) return null;
  const body = await parseJsonOrThrow<{ data: ConversionEvent }>(res);
  return body.data;
}
