import { randomUUID } from "crypto";
import type { RequestHandler } from "express";
import { logContext, loggableBody, redactHeaders, type Logger } from "../lib/logger";

declare module "http" {
  interface IncomingMessage {
    /** Exact request bytes, captured by express.json's `verify` hook (see app.ts). */
    rawBody?: Buffer;
  }
}

// Accept a caller's X-Request-Id (nginx sets one) only if it looks like an
// id, so arbitrary header content can't be injected into log lines.
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Logs every request as two lines sharing a requestId:
 *   → on arrival: method, URL, client IP, headers (credentials redacted)
 *   ← when the response is sent: status, duration, the request body the
 *     client sent, and the response body it got back — at `warn` for 4xx and
 *     `error` for 5xx, so every error returned to a client is logged together
 *     with its payload.
 * Must be registered before body parsing: a body that fails to parse still
 * produces both lines (its raw text is logged).
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incomingId = req.header("x-request-id");
    const requestId = incomingId && REQUEST_ID.test(incomingId) ? incomingId : randomUUID();
    const log = logger.child({ requestId });
    const startedAt = process.hrtime.bigint();
    const target = `${req.method} ${req.originalUrl}`;

    res.setHeader("X-Request-Id", requestId);
    res.locals.log = log;

    // res.json() goes through res.send(), so this captures every body we return.
    let responseBody: unknown;
    const send = res.send.bind(res);
    res.send = (body?: unknown) => {
      responseBody = body;
      return send(body);
    };

    log.info(`→ ${target}`, {
      request: { method: req.method, url: req.originalUrl, ip: req.ip, headers: redactHeaders(req.headers) },
    });

    const elapsedMs = () => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    let finished = false;

    res.on("finish", () => {
      finished = true;
      const status = res.statusCode;
      const durationMs = elapsedMs();
      log.log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", `← ${status} ${target} (${durationMs}ms)`, {
        request: { method: req.method, url: req.originalUrl, body: loggableBody(req.rawBody) },
        response: {
          status,
          durationMs,
          headers: redactHeaders(res.getHeaders()),
          body: loggableBody(responseBody),
          // Which exception produced an error response (set by app.ts's error handler).
          ...(res.locals.errorName && { error: res.locals.errorName }),
        },
      });
    });

    res.on("close", () => {
      if (!finished) {
        log.warn(`client disconnected before the response to ${target} was sent (${elapsedMs()}ms)`);
      }
    });

    // Everything downstream (routes, services, the tracker adapter) logs with this requestId.
    logContext.run({ requestId }, next);
  };
}
