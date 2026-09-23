import "dotenv/config";
import express from "express";

// Local stand-in for https://bipro2interface.sseku.com/api/candidate-tracker,
// used ONLY for local development while waiting on a real API key, or to
// exercise retry logic without spending the real rate limit. Mirrors the
// response shapes documented in the assignment (ping / conversions,
// duplicate detection, validation errors, simulate:"server_error").
// Not part of the submission's actual functionality.

const PORT = Number(process.env.MOCK_TRACKER_PORT ?? 4000);
const MOCK_API_KEY = process.env.MOCK_TRACKER_API_KEY ?? "dev-mock-key";

// How POST /conversions misbehaves, to exercise each failure path:
//   normal       - documented behavior (201, then 200 duplicate:true)
//   server_error - always 500
//   rate_limited - always 429
//   garbled_ok   - 200 with an HTML body instead of the documented JSON
//   hang         - never responds (the caller's timeout must fire)
//   slow_first   - the first request for each event_id is held for
//                  MOCK_TRACKER_SLOW_MS before answering; later ones answer
//                  at once (for racing a stale claim against its reclaim)
const BEHAVIOR = process.env.MOCK_TRACKER_BEHAVIOR ?? "normal";
const SLOW_MS = Number(process.env.MOCK_TRACKER_SLOW_MS ?? 8_000);

const app = express();
app.use(express.json());

const seenEventIds = new Set<string>();
const requestedEventIds = new Set<string>();

function checkAuth(req: express.Request, res: express.Response): boolean {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== MOCK_API_KEY) {
    res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Missing or invalid API key. Send Authorization: Bearer <key>.",
    });
    return false;
  }
  return true;
}

app.get("/api/candidate-tracker/ping", (req, res) => {
  if (!checkAuth(req, res)) return;
  res.status(200).json({ ok: true, candidate: "local-mock", time: new Date().toISOString() });
});

app.post("/api/candidate-tracker/conversions", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const body = req.body ?? {};
  const errors: Record<string, string[]> = {};
  if (!body.event_id || typeof body.event_id !== "string") {
    errors.event_id = ["event_id is required"];
  }
  if (!body.email && !body.phone) {
    errors.contact = ["Provide email or phone."];
  }
  if (body.currency && !/^[A-Za-z]{3}$/.test(body.currency)) {
    errors.currency = ["currency must be exactly 3 letters"];
  }
  if (Object.keys(errors).length > 0) {
    return res.status(422).json({ ok: false, error: "validation_error", errors });
  }

  if (BEHAVIOR === "server_error" || body.simulate === "server_error") {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Simulated 500. Retry this event_id.",
    });
  }
  if (BEHAVIOR === "rate_limited") {
    return res.status(429).json({ ok: false, error: "rate_limited", message: "Too many requests." });
  }
  if (BEHAVIOR === "garbled_ok") {
    return res.status(200).type("html").send("<html><body>OK</body></html>");
  }
  if (BEHAVIOR === "hang") {
    return; // never respond
  }
  if (BEHAVIOR === "slow_first" && !requestedEventIds.has(body.event_id)) {
    requestedEventIds.add(body.event_id);
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  }

  const isDuplicate = seenEventIds.has(body.event_id);
  seenEventIds.add(body.event_id);

  res.status(isDuplicate ? 200 : 201).json({
    ok: true,
    duplicate: isDuplicate,
    event_id: body.event_id,
    received_at: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`mock tracker listening on http://localhost:${PORT} (behavior: ${BEHAVIOR})`);
  console.log(`mock API key: ${MOCK_API_KEY}`);
});
