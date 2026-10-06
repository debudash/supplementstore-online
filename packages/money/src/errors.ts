/**
 * Error types for the money package.
 *
 * Codes mirror docs/ARCHITECTURE.md section 9:
 *   - INVALID_INPUT   -> HTTP 400 (bad/unsafe input reached the split math)
 *   - MARGIN_NEGATIVE -> HTTP 422 (a line's margin after its allocated fee is < 0)
 *
 * Carrying a stable `code` lets the API layer map these to HTTP statuses without
 * string-matching messages.
 */
export type MoneyErrorCode = "INVALID_INPUT" | "MARGIN_NEGATIVE";

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MoneyErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    // Preserve prototype chain when targeting ES5-ish transpilation.
    Object.setPrototypeOf(this, MoneyError.prototype);
  }
}
