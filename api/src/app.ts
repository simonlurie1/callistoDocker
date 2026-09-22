import express, { ErrorRequestHandler } from "express";
import { leadsRouter } from "./routes/leads";
import { conversionEventsRouter } from "./routes/conversionEvents";
import { HttpError } from "./lib/errors";

// Note: unlike v1 (where Express also served the static UI directly), here
// the React UI is built and served by its own nginx container, which
// reverse-proxies /leads, /conversion-events, /health to this API
// container (see web/nginx.conf). The browser only ever talks to the
// nginx origin, so no CORS setup is needed here.
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/leads", leadsRouter);
  app.use("/conversion-events", conversionEventsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `no route for ${req.method} ${req.path}` });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
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
