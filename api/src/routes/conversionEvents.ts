import { Router } from "express";
import type { ConversionService } from "../services/conversionService";

export function createConversionEventsRouter(conversionService: ConversionService): Router {
  const router = Router();

  // Lets a reviewer see exactly what was sent/received for every outbound
  // conversion, without digging through logs.
  router.get("/", async (_req, res, next) => {
    try {
      res.json({ data: await conversionService.listEvents() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/tracker-ping", async (_req, res, next) => {
    try {
      const result = await conversionService.checkTrackerConnectivity();
      res.status(result.httpStatus || 502).json(result.body ?? { error: "no_response", detail: result.networkError });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
