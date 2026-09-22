import type { ConversionEvent } from "../domain/models";

/** API shape of a conversion event. The payload is exposed as `requestBody`,
 * the exact JSON string sent to the tracker. */
export function presentConversionEvent(event: ConversionEvent) {
  const { payload, ...rest } = event;
  return { ...rest, requestBody: JSON.stringify(payload) };
}
