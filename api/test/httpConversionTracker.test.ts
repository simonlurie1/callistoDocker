import { describe, expect, it, vi } from "vitest";
import type { ConversionPayload } from "../src/domain/models";
import type { Logger } from "../src/lib/logger";
import { HttpConversionTracker } from "../src/tracker/http/HttpConversionTracker";

const API_KEY = "test-secret-key-12345";
const BASE_URL = "https://tracker.test/api";
const payload: ConversionPayload = { event_id: "conv_1_abcd1234", email: "dana@example.com", amount: 10, currency: "USD" };

/** A logger that just remembers everything logged, so tests can inspect it. */
function recordingLogger() {
  const lines: unknown[] = [];
  const logger = {
    child: () => logger,
    log: (...args: unknown[]) => lines.push(args),
    info: (...args: unknown[]) => lines.push(args),
    warn: (...args: unknown[]) => lines.push(args),
    error: (...args: unknown[]) => lines.push(args),
    debug: (...args: unknown[]) => lines.push(args),
  };
  return { logger: logger as unknown as Logger, lines };
}

/** Replaces the global fetch with one that answers `status` + `body` (+ headers). */
function trackerAnswers(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fetchMock = vi.fn(async () => new Response(text, { status, headers }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function createTracker() {
  const { logger, lines } = recordingLogger();
  const tracker = new HttpConversionTracker({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1_000, minIntervalMs: 0 }, logger);
  return { tracker, lines };
}

describe("HttpConversionTracker.send", () => {
  it("POSTs the payload as JSON with the API key as a Bearer token", async () => {
    const fetchMock = trackerAnswers(201, { ok: true, duplicate: false });
    const { tracker } = createTracker();

    await tracker.send(payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/conversions`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  // How each tracker answer is classified — the table from the README.
  it.each([
    { answer: "201 created", status: 201, body: { ok: true, duplicate: false }, outcome: "accepted" },
    { answer: "200 duplicate:true", status: 200, body: { ok: true, duplicate: true }, outcome: "duplicate" },
    { answer: "500 server error", status: 500, body: { ok: false }, outcome: "retryable_failure" },
    { answer: "503 unavailable", status: 503, body: "Service Unavailable", outcome: "retryable_failure" },
    { answer: "429 rate limited", status: 429, body: { ok: false }, outcome: "retryable_failure" },
    { answer: "408 request timeout", status: 408, body: "", outcome: "retryable_failure" },
    { answer: "200 with an HTML body", status: 200, body: "<html>OK</html>", outcome: "retryable_failure" },
    { answer: "404 (undocumented)", status: 404, body: "Not Found", outcome: "retryable_failure" },
    { answer: "401 unauthorized", status: 401, body: { ok: false, error: "unauthorized" }, outcome: "permanent_failure" },
    { answer: "422 validation error", status: 422, body: { ok: false }, outcome: "permanent_failure" },
  ])("$answer → $outcome", async ({ status, body, outcome }) => {
    trackerAnswers(status, body);
    const { tracker } = createTracker();

    const result = await tracker.send(payload);

    expect(result.outcome).toBe(outcome);
    expect(result.httpStatus).toBe(status);
  });

  it("keeps the raw response body for the audit trail", async () => {
    trackerAnswers(201, { ok: true, duplicate: false, event_id: payload.event_id });
    const { tracker } = createTracker();
    expect(JSON.parse((await tracker.send(payload)).responseBody!)).toMatchObject({ event_id: payload.event_id });
  });

  it("reads Retry-After in seconds", async () => {
    trackerAnswers(429, { ok: false }, { "Retry-After": "120" });
    const { tracker } = createTracker();
    expect((await tracker.send(payload)).retryAfterSeconds).toBe(120);
  });

  it("reads Retry-After as an HTTP date", async () => {
    const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
    trackerAnswers(503, { ok: false }, { "Retry-After": inTwoMinutes });
    const { tracker } = createTracker();
    const seconds = (await tracker.send(payload)).retryAfterSeconds!;
    expect(seconds).toBeGreaterThan(115);
    expect(seconds).toBeLessThanOrEqual(120);
  });

  it("ignores Retry-After on a success", async () => {
    trackerAnswers(201, { ok: true, duplicate: false }, { "Retry-After": "120" });
    const { tracker } = createTracker();
    expect((await tracker.send(payload)).retryAfterSeconds).toBeNull();
  });

  it("no response (network failure) → retryable, with the reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const { tracker } = createTracker();

    expect(await tracker.send(payload)).toMatchObject({
      outcome: "retryable_failure",
      httpStatus: null,
      responseBody: null,
      error: "fetch failed",
    });
  });

  it("a timeout → retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    const { tracker } = createTracker();

    expect(await tracker.send(payload)).toMatchObject({ outcome: "retryable_failure", httpStatus: null });
  });

  it("never writes the API key to the logs", async () => {
    trackerAnswers(201, { ok: true, duplicate: false });
    const { tracker, lines } = createTracker();

    await tracker.send(payload);
    await tracker.ping();

    const everythingLogged = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(everythingLogged).not.toContain(API_KEY);
    expect(everythingLogged).toContain("[REDACTED]");
  });

  it("refuses to start without an API key", () => {
    const { logger } = recordingLogger();
    expect(
      () => new HttpConversionTracker({ baseUrl: BASE_URL, apiKey: "", timeoutMs: 1_000, minIntervalMs: 0 }, logger)
    ).toThrow(/TRACKER_API_KEY/);
  });
});
