import { useEffect, useState } from "react";
import { fetchConversionEvent } from "../api";
import type { ConversionEvent } from "../types";

// The worker runs a pass every 5 seconds by default, so polling at a similar
// rate shows the outcome a few seconds after it's posted.
const POLL_MS = 3000;

function safeParse(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Waiting for the worker: just recorded / re-queued, or being posted right now. */
function isInFlight(event: ConversionEvent | null): boolean {
  return event?.status === "pending" || event?.status === "in_process";
}

export function ConversionDetail({ event }: { event: ConversionEvent | null }) {
  const [current, setCurrent] = useState(event);
  useEffect(() => setCurrent(event), [event]);

  // Converting only records the event; the worker posts it a moment later.
  // Poll until it reaches sent/failed so the outcome shows up without a refresh.
  const leadId = current?.leadId;
  const inFlight = isInFlight(current);
  useEffect(() => {
    if (leadId === undefined || !inFlight) return;
    const timer = setInterval(async () => {
      try {
        const fresh = await fetchConversionEvent(leadId);
        if (fresh) setCurrent(fresh);
      } catch {
        // transient; the next tick retries
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [leadId, inFlight]);

  return (
    <section className="card">
      <h2>Conversion event detail</h2>
      {inFlight && (
        <p className="subtitle">
          Status: {current?.status} — recorded; the worker posts it within a few seconds (a failed attempt is
          retried with backoff). This panel updates on its own once it's posted.
        </p>
      )}
      <pre className="event-detail">
        {current
          ? JSON.stringify(
              { ...current, requestBody: safeParse(current.requestBody), responseBody: safeParse(current.responseBody) },
              null,
              2
            )
          : 'Click "Conversion" next to a converted lead to see the stored request/response.'}
      </pre>
    </section>
  );
}
