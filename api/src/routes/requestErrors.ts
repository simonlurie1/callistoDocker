/** The request itself is malformed (wrong types, bad formats), as opposed to
 * a business-rule violation. Rendered as 422, like domain validation errors. */
export class RequestValidationError extends Error {
  constructor(readonly details: Record<string, string[]>) {
    super("validation_error");
  }
}
