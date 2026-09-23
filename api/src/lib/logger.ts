import { AsyncLocalStorage } from "async_hooks";
import winston from "winston";

export type Logger = winston.Logger;

/**
 * Context of the unit of work being handled — an HTTP request's `requestId`,
 * a batch pass's `passId` — added to every log line written while handling
 * it, including from code that never receives a logger (e.g. the tracker
 * adapter called deep inside a service). Set with `logContext.run(...)`.
 */
export const logContext = new AsyncLocalStorage<Record<string, string>>();

const addContext = winston.format((info) => {
  const context = logContext.getStore();
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (info[key] === undefined) info[key] = value;
    }
  }
  return info;
});

// Human-readable single line for local development (LOG_FORMAT=pretty).
const prettyLine = winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
  const details = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} ${level} [${service}] ${message}${details}`;
});

export const logger: Logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  defaultMeta: { service: "api" },
  format: winston.format.combine(
    addContext(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.LOG_FORMAT === "pretty"
      ? winston.format.combine(winston.format.colorize(), prettyLine)
      : winston.format.json()
  ),
  // JSON to stdout: `docker compose logs` collects it, and a log shipper can
  // parse it without regexes. Crashes are logged the same way before exit.
  transports: [new winston.transports.Console({ handleExceptions: true, handleRejections: true })],
});

/** Tags every subsequent line with the process's role (api / worker / ...). */
export function setServiceName(service: string): void {
  logger.defaultMeta = { ...logger.defaultMeta, service };
}

/** Errors nested in log metadata would serialize to `{}` (their fields are
 * non-enumerable), so they're converted explicitly. */
export function errorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, message: err.message, ...(code !== undefined && { code }), stack: err.stack };
  }
  return { message: String(err) };
}

const REDACTED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

/** Credentials — above all the tracker API key in `Authorization` — must
 * never reach the logs. */
export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, REDACTED_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value])
  );
}

const MAX_BODY_CHARS = Number(process.env.LOG_MAX_BODY_CHARS ?? 4096);

/** A request/response body as it should appear in a log line: JSON parsed
 * (so it's searchable as structure, not an escaped string), empty bodies
 * dropped, and anything over LOG_MAX_BODY_CHARS truncated. */
export function loggableBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  let value: unknown = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  if (value === "") return undefined;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // not JSON — log the text as is
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= MAX_BODY_CHARS) return value;
  return `${text.slice(0, MAX_BODY_CHARS)}… [truncated ${text.length - MAX_BODY_CHARS} chars]`;
}
