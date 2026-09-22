import type { ConversionEvent } from "../types";

function safeParse(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function ConversionDetail({ event }: { event: ConversionEvent | null }) {
  return (
    <section className="card">
      <h2>Conversion event detail</h2>
      <pre className="event-detail">
        {event
          ? JSON.stringify(
              { ...event, requestBody: safeParse(event.requestBody), responseBody: safeParse(event.responseBody) },
              null,
              2
            )
          : 'Click "Conversion" next to a converted lead to see the stored request/response.'}
      </pre>
    </section>
  );
}
