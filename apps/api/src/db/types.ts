// Postgres type parsing and safe-integer helpers for money (AGENTS.md money rule 10).
//
// `pg` returns bigint (int8) and numeric as strings to avoid silent precision loss.
// Money lives in integer cents, so every value we pull back must be a safe integer.
import pg from 'pg'

const INT8_OID = 20
const NUMERIC_OID = 1700

let typeParsersInstalled = false

/**
 * Install global pg type parsers once. int8 and numeric are parsed to numbers only
 * after a safe-integer check; anything outside Number.MAX_SAFE_INTEGER throws rather
 * than silently losing precision.
 */
export function installPgTypeParsers(): void {
  if (typeParsersInstalled) return
  pg.types.setTypeParser(INT8_OID, (value: string) => parseBigIntSafe(value))
  pg.types.setTypeParser(NUMERIC_OID, (value: string) => parseBigIntSafe(value))
  typeParsersInstalled = true
}

/**
 * Parse a DB-returned integer string (bigint/numeric) into a safe JS integer.
 * Throws on non-integer or out-of-range input. Never use a raw `Number()` on
 * a bigint column (AGENTS.md money rule 10).
 */
export function parseBigIntSafe(value: string | number | null): number {
  if (value === null) {
    throw new Error('parseBigIntSafe: received null')
  }
  if (typeof value === 'number') {
    assertSafeInteger(value)
    return value
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`parseBigIntSafe: not an integer string: ${value}`)
  }
  const n = Number(value)
  assertSafeInteger(n)
  return n
}

/** Throw unless `n` is a safe integer. Use before any money arithmetic. */
export function assertSafeInteger(n: number): void {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`value is not a safe integer: ${n}`)
  }
}
