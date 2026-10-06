import { MoneyError } from "./errors";

/**
 * Input validation for the money package.
 *
 * AGENTS.md section 3 and the T1 task require that every input is validated as a
 * safe integer before any arithmetic runs. This is the first line of defence for
 * RED_TEAM AI-01 / RT-07: no float, NaN, string "29.99", or value beyond
 * Number.MAX_SAFE_INTEGER may reach fee/allocation/split math. On any violation
 * we throw MoneyError("INVALID_INPUT") rather than silently coercing.
 */

/** Throws unless `value` is an integer in the inclusive range [min, max]. */
export function assertSafeIntegerInRange(
  value: number,
  name: string,
  min: number,
  max: number,
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new MoneyError("INVALID_INPUT", `${name} must be a safe integer`, {
      field: name,
      value,
    });
  }
  if (value < min || value > max) {
    throw new MoneyError(
      "INVALID_INPUT",
      `${name} must be between ${min} and ${max}`,
      { field: name, value, min, max },
    );
  }
}

/** Throws unless `value` is a safe integer strictly greater than 0. */
export function assertSafePositiveInt(value: number, name: string): void {
  assertSafeIntegerInRange(value, name, 1, Number.MAX_SAFE_INTEGER);
}

/** Throws unless `value` is a safe integer greater than or equal to 0. */
export function assertSafeNonNegativeInt(value: number, name: string): void {
  assertSafeIntegerInRange(value, name, 0, Number.MAX_SAFE_INTEGER);
}
