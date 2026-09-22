export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

// Common ISO 4217 currency codes. Not the full ~180-code standard — a
// curated allowlist of the currencies this CRM is expected to actually see,
// so a typo'd/nonsense code (e.g. "ZZZ") is rejected instead of silently
// accepted just for being 3 letters. See README "Assumptions".
export const SUPPORTED_CURRENCIES = [
  "ILS", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY",
  "HKD", "NZD", "SEK", "KRW", "SGD", "NOK", "MXN", "INR", "RUB",
  "ZAR", "TRY", "BRL", "AED", "SAR", "TWD", "PLN", "THB", "DKK",
] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value);
}

export function isSupportedCurrency(value: unknown): value is SupportedCurrency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
