const BASE_URL = process.env.TRACKER_BASE_URL ?? "https://bipro2interface.sseku.com/api/candidate-tracker";
const API_KEY = process.env.TRACKER_API_KEY;

export interface ConversionPayload {
  event_id: string;
  event_name?: string;
  email?: string;
  phone?: string;
  lead_id?: string;
  amount?: number;
  currency?: string;
  occurred_at?: string;
  simulate?: "server_error";
}

export interface TrackerResponse {
  httpStatus: number;
  body: unknown;
  /** Network-level failure (no response at all), as opposed to a non-2xx HTTP response. */
  networkError?: string;
}

function authHeaders(): Record<string, string> {
  if (!API_KEY) {
    throw new Error("TRACKER_API_KEY is not set. Add it to your .env file.");
  }
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function ping(): Promise<TrackerResponse> {
  try {
    const res = await fetch(`${BASE_URL}/ping`, {
      method: "GET",
      headers: authHeaders(),
    });
    const body = await safeJson(res);
    return { httpStatus: res.status, body };
  } catch (err) {
    return { httpStatus: 0, body: null, networkError: (err as Error).message };
  }
}

export async function postConversion(payload: ConversionPayload): Promise<TrackerResponse> {
  try {
    const res = await fetch(`${BASE_URL}/conversions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await safeJson(res);
    return { httpStatus: res.status, body };
  } catch (err) {
    return { httpStatus: 0, body: null, networkError: (err as Error).message };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
