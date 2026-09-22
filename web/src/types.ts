export const STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof STATUSES)[number];

// Keep in sync with SUPPORTED_CURRENCIES in api/src/lib/constants.ts.
export const CURRENCIES = [
  "ILS", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY",
  "HKD", "NZD", "SEK", "KRW", "SGD", "NOK", "MXN", "INR", "RUB",
  "ZAR", "TRY", "BRL", "AED", "SAR", "TWD", "PLN", "THB", "DKK",
];

export interface Lead {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: LeadStatus;
  amount: number | null;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversionEvent {
  id: number;
  eventId: string;
  leadId: number;
  status: "pending" | "in_process" | "sent" | "failed";
  attempts: number;
  requestBody: string;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  processingStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
  errors?: Record<string, string[] | undefined>;
}
