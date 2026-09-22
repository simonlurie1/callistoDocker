// Business-level failures. They carry no transport details (no HTTP status
// codes); the HTTP layer decides how each one is represented (see app.ts).

export class DomainError extends Error {}

export class NotFoundError extends DomainError {}

/** Input breaks a business rule; `details` maps field -> messages. */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly details: Record<string, string[] | undefined>
  ) {
    super(message);
  }
}

/** The action conflicts with the entity's current state (e.g. converting a lost lead). */
export class ConflictError extends DomainError {}
