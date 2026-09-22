import { Router } from "express";
import { prisma } from "../lib/prisma";
import { checkTrackerConnectivity } from "../services/conversionService";

export const conversionEventsRouter = Router();

// Lets a reviewer see exactly what was sent/received for every outbound
// conversion, without digging through logs.
conversionEventsRouter.get("/", async (_req, res, next) => {
  try {
    const events = await prisma.conversionEvent.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ data: events });
  } catch (err) {
    next(err);
  }
});

conversionEventsRouter.get("/tracker-ping", async (_req, res, next) => {
  try {
    const result = await checkTrackerConnectivity();
    res.status(result.httpStatus || 502).json(result.body ?? { error: "no_response", detail: result.networkError });
  } catch (err) {
    next(err);
  }
});
