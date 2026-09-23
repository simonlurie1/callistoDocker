import type { ConversionPayload } from "../../domain/models";
import { errorDetails, loggableBody, redactHeaders, type Logger } from "../../lib/logger";
import type { ConversionTracker, DeliveryOutcome, DeliveryResult, PingResult } from "../ConversionTracker";

export interface HttpTrackerConfig {
  baseUrl: string;
  apiKey: string;
  /** Without a timeout a hung tracker would hang the request (and the retry
   * command) indefinitely; a timeout is reported as a retryable failure. */
  timeoutMs: number;
  /** Minimum gap between posts, to stay under the tracker's 30 requests/minute
   * limit (2100ms ≈ 28/min). Enforced per process: N worker replicas can reach
   * N times that, and the resulting 429s are retried with backoff. */
  minIntervalMs: number;
}

interface HttpExchange {
  status: number;
  headers: Record<string, string>;
  text: string;
  durationMs: number;
}

/** Talks to Callisto's tracker over HTTP and translates its responses into
 * delivery outcomes. The only code that knows the tracker's status codes.
 * Every outgoing request and every response (or failure to get one) is
 * logged; the Authorization header carrying the API key is redacted. */
export class HttpConversionTracker implements ConversionTracker {
  private nextSendAt = 0;

  constructor(
    private readonly config: HttpTrackerConfig,
    private readonly log: Logger
  ) {
    if (!config.apiKey) {
      throw new Error("TRACKER_API_KEY is not set. Add it to your .env file.");
    }
  }

  async send(payload: ConversionPayload): Promise<DeliveryResult> {
    await this.throttle();
    const log = this.log.child({ eventId: payload.event_id });
    let exchange: HttpExchange;
    try {
      exchange = await this.request(log, "POST", "/conversions", payload);
    } catch (err) {
      return { outcome: "retryable_failure", httpStatus: null, responseBody: null, error: (err as Error).message };
    }

    const outcome = classify(exchange.status, exchange.text);
    const level = outcome === "accepted" || outcome === "duplicate" ? "info" : outcome === "retryable_failure" ? "warn" : "error";
    log.log(level, `tracker conversion outcome: ${outcome}`, { outcome, status: exchange.status });
    return { outcome, httpStatus: exchange.status, responseBody: exchange.text, error: null };
  }

  async ping(): Promise<PingResult> {
    try {
      const exchange = await this.request(this.log, "GET", "/ping");
      return { httpStatus: exchange.status, body: parseJson(exchange.text), error: null };
    } catch (err) {
      return { httpStatus: null, body: null, error: (err as Error).message };
    }
  }

  /** One logged HTTP round trip. Throws if no response arrived (network
   * failure or timeout) — after logging it. */
  private async request(log: Logger, method: string, path: string, payload?: unknown): Promise<HttpExchange> {
    const url = `${this.config.baseUrl}${path}`;
    const headers = { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" };
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    log.info(`→ tracker ${method} ${url}`, {
      trackerRequest: { method, url, headers: redactHeaders(headers), body: loggableBody(body) },
    });

    const startedAt = performance.now();
    const elapsedMs = () => Math.round((performance.now() - startedAt) * 10) / 10;
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.config.timeoutMs) });
      const text = await res.text();
      const exchange: HttpExchange = {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        text,
        durationMs: elapsedMs(),
      };
      log.log(res.ok ? "info" : "warn", `← tracker ${res.status} ${method} ${url} (${exchange.durationMs}ms)`, {
        trackerResponse: {
          status: exchange.status,
          durationMs: exchange.durationMs,
          headers: redactHeaders(exchange.headers),
          body: loggableBody(text),
        },
      });
      return exchange;
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      log.warn(
        `✗ tracker ${method} ${url} got no response: ${timedOut ? `timed out after ${this.config.timeoutMs}ms` : (err as Error).message}`,
        { trackerResponse: { durationMs: elapsedMs(), timedOut, error: errorDetails(err) } }
      );
      throw err;
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.nextSendAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextSendAt = Date.now() + this.config.minIntervalMs;
  }
}

function classify(status: number, text: string): DeliveryOutcome {
  if (status === 201) return "accepted";
  const body = parseJson(text) as { duplicate?: unknown } | null;
  if (status === 200 && body?.duplicate === true) return "duplicate";
  // 5xx, plus 429 (the tracker's 30 req/min limit) and 408, are transient.
  if (status >= 500 || status === 429 || status === 408) return "retryable_failure";
  // The only two documented non-retryable rejections: a malformed payload
  // (422) and a bad/expired key (401) — retrying the same request changes
  // nothing for either.
  if (status === 401 || status === 422) return "permanent_failure";
  // Anything else — an unexpected status code, or a 200 whose body doesn't
  // match the documented duplicate shape — isn't a case the tracker
  // documents as a rejection. Retrying is the safer default: worst case a
  // retry gets duplicate:true back (harmless, event_id is idempotent);
  // giving up risks silently losing a conversion that actually went through.
  return "retryable_failure";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
