import { Router } from "express";
import type { ConversionService } from "../services/conversionService";
import type { ConversionTracker } from "../tracker/ConversionTracker";
import { presentConversionEvent } from "./presenters";

export function createConversionEventsRouter(
  conversionService: ConversionService,
  tracker: ConversionTracker
): Router {
  const router = Router();

  // Lets a reviewer see exactly what was sent/received for every outbound
  // conversion, without digging through logs.
  router.get("/", async (_req, res, next) => {
    try {
      const events = await conversionService.listEvents();
      res.json({ data: events.map(presentConversionEvent) });
    } catch (err) {
      next(err);
    }
  });

  // Connectivity check only — no business logic, so it talks to the
  // tracker port directly rather than through a service.
  router.get("/tracker-ping", async (_req, res, next) => {
    try {
      const result = await tracker.ping();
      res.status(result.httpStatus ?? 502).json(result.body ?? { error: "no_response", detail: result.error });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
