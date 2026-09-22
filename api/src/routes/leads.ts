import { Router } from "express";
import type { ConversionService } from "../services/conversionService";
import type { LeadService } from "../services/leadService";
import { NotFoundError } from "../lib/errors";

// A non-numeric id (e.g. /leads/abc) would otherwise reach the database as
// NaN and surface as a 500.
function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(`lead ${raw} not found`);
  return id;
}

export function createLeadsRouter(leadService: LeadService, conversionService: ConversionService): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const { status, source } = req.query;
      const leads = await leadService.listLeads({
        status: typeof status === "string" ? status : undefined,
        source: typeof source === "string" ? source : undefined,
      });
      res.json({ data: leads });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const lead = await leadService.createLead(req.body ?? {});
      res.status(201).json({ data: lead });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const lead = await leadService.getLead(parseId(req.params.id));
      res.json({ data: lead });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      if (req.body && typeof req.body === "object" && "status" in req.body) {
        return res.status(400).json({
          error: "use_dedicated_endpoint",
          message: "status changes must go through PATCH /leads/:id/status",
        });
      }
      const lead = await leadService.updateLead(parseId(req.params.id), req.body ?? {});
      res.json({ data: lead });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await leadService.deleteLead(parseId(req.params.id));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id/status", async (req, res, next) => {
    try {
      const result = await leadService.changeStatus(parseId(req.params.id), req.body?.status);
      res.json({ data: result.lead, conversionEvent: result.conversionEvent ?? undefined });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/conversion-event", async (req, res, next) => {
    try {
      const event = await conversionService.getEventForLead(parseId(req.params.id));
      if (!event) {
        return res.status(404).json({ error: "not_found", message: "no conversion event for this lead" });
      }
      res.json({ data: event });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
