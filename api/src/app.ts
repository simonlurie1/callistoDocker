import express, { ErrorRequestHandler } from "express";
import { createLeadsRouter } from "./routes/leads";
import { createConversionEventsRouter } from "./routes/conversionEvents";
import { HttpError } from "./lib/errors";
import type { Container } from "./container";

// Note: unlike v1 (where Express also served the static UI directly), here
// the React UI is built and served by its own nginx container, which
// reverse-proxies /leads, /conversion-events, /health to this API
// container (see web/nginx.conf). The browser only ever talks to the
// nginx origin, so no CORS setup is needed here.
export function createApp({ leadService, conversionService }: Pick<Container, "leadService" | "conversionService">) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/leads", createLeadsRouter(leadService, conversionService));
  app.use("/conversion-events", createConversionEventsRouter(conversionService));

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `no route for ${req.method} ${req.path}` });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if ((err as { type?: string }).type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json", message: "request body is not valid JSON" });
    }
    if (err instanceof HttpError) {
      const payload: Record<string, unknown> = { error: err.message };
      if (err.details) payload.errors = err.details;
      return res.status(err.statusCode).json(payload);
    }
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "unexpected server error" });
  };
  app.use(errorHandler);

  return app;
}
