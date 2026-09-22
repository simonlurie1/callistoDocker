import express, { ErrorRequestHandler } from "express";
import { createLeadsRouter } from "./routes/leads";
import { createConversionEventsRouter } from "./routes/conversionEvents";
import { RequestValidationError } from "./routes/requestErrors";
import { ConflictError, NotFoundError, ValidationError } from "./domain/errors";
import type { Container } from "./container";

// Note: unlike v1 (where Express also served the static UI directly), here
// the React UI is built and served by its own nginx container, which
// reverse-proxies /leads, /conversion-events, /health to this API
// container (see web/nginx.conf). The browser only ever talks to the
// nginx origin, so no CORS setup is needed here.
export function createApp({
  leadService,
  conversionService,
  tracker,
}: Pick<Container, "leadService" | "conversionService" | "tracker">) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/leads", createLeadsRouter(leadService, conversionService));
  app.use("/conversion-events", createConversionEventsRouter(conversionService, tracker));

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `no route for ${req.method} ${req.path}` });
  });

  // The one place domain/request errors become HTTP status codes.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if ((err as { type?: string }).type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "request body is not valid JSON" });
    }
    if (err instanceof RequestValidationError || err instanceof ValidationError) {
      return res.status(422).json({ error: err.message, errors: err.details });
    }
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "unexpected server error" });
  };
  app.use(errorHandler);

  return app;
}
