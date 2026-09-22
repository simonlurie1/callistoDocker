import type { ConversionPayload } from "../../domain/models";
import type { ConversionTracker, DeliveryOutcome, DeliveryResult, PingResult } from "../ConversionTracker";

export interface HttpTrackerConfig {
  baseUrl: string;
  apiKey: string;
  /** Without a timeout a hung tracker would hang the request (and the retry
   * command) indefinitely; a timeout is reported as a retryable failure. */
  timeoutMs: number;
}

/** Talks to Callisto's tracker over HTTP and translates its responses into
 * delivery outcomes. The only code that knows the tracker's status codes. */
export class HttpConversionTracker implements ConversionTracker {
  constructor(private readonly config: HttpTrackerConfig) {
    if (!config.apiKey) {
      throw new Error("TRACKER_API_KEY is not set. Add it to your .env file.");
    }
  }

  async send(payload: ConversionPayload): Promise<DeliveryResult> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.config.baseUrl}/conversions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      return { outcome: "retryable_failure", httpStatus: null, responseBody: null, error: (err as Error).message };
    }
    return { outcome: classify(res.status, text), httpStatus: res.status, responseBody: text, error: null };
  }

  async ping(): Promise<PingResult> {
    try {
      const res = await fetch(`${this.config.baseUrl}/ping`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      return { httpStatus: res.status, body: parseJson(await res.text()), error: null };
    } catch (err) {
      return { httpStatus: null, body: null, error: (err as Error).message };
    }
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" };
  }
}

function classify(status: number, text: string): DeliveryOutcome {
  if (status === 201) return "accepted";
  if (status === 200 && (parseJson(text) as { duplicate?: unknown } | null)?.duplicate === true) {
    return "duplicate";
  }
  // 5xx, plus 429 (the tracker's 30 req/min limit) and 408, are transient.
  if (status >= 500 || status === 429 || status === 408) return "retryable_failure";
  return "permanent_failure";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
