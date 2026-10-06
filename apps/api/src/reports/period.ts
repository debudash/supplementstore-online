// Period resolution for reports (NFR-6: all periods are UTC calendar boundaries).
//
// A report window is expressed to clients as two inclusive calendar dates
// (YYYY-MM-DD). Internally we work with the half-open timestamptz interval
// [startTs, endTsExclusive) so an event at 23:59:59.999Z on the last day is included
// and the first instant of the next day is not. Month helpers back FR-11's monthly
// default and the Cerbo Admin month close.
import { invalidInput } from './errors'

/** A resolved reporting window: inclusive date labels plus the half-open ts interval. */
export interface ResolvedPeriod {
  /** Inclusive start date, YYYY-MM-DD (UTC). */
  from: string
  /** Inclusive end date, YYYY-MM-DD (UTC). */
  to: string
  /** Interval start (inclusive). */
  startTs: Date
  /** Interval end (exclusive) = day after `to` at 00:00:00Z. */
  endTsExclusive: Date
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/** Zero-pad a 1- or 2-digit number to width 2. */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Format a UTC Date as YYYY-MM-DD (date part only). */
export function formatDateOnly(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** Parse a YYYY-MM-DD string to a UTC-midnight Date, or throw INVALID_INPUT. */
function parseDateOnly(value: string, field: string): Date {
  if (!DATE_RE.test(value)) {
    throw invalidInput(`${field} must be a YYYY-MM-DD date`, { field, value })
  }
  const [y, m, d] = value.split('-').map(Number)
  const ts = Date.UTC(y, m - 1, d)
  const date = new Date(ts)
  // Reject impossible dates (e.g. 2026-02-31 would roll over to March).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw invalidInput(`${field} is not a valid calendar date`, { field, value })
  }
  return date
}

/** The UTC calendar month containing `now`, as a ResolvedPeriod. */
export function currentMonthPeriod(now: Date = new Date()): ResolvedPeriod {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1)
}

/** Build a ResolvedPeriod for a 1-based (year, month). */
function monthPeriod(year: number, month1: number): ResolvedPeriod {
  const startTs = new Date(Date.UTC(year, month1 - 1, 1))
  const endTsExclusive = new Date(Date.UTC(year, month1, 1))
  // Last day of the month = the day before the exclusive end.
  const lastDay = new Date(endTsExclusive.getTime() - 24 * 60 * 60 * 1000)
  return {
    from: formatDateOnly(startTs),
    to: formatDateOnly(lastDay),
    startTs,
    endTsExclusive
  }
}

/**
 * Resolve a month token ("YYYY-MM", also tolerates a full "YYYY-MM-DD" by taking its
 * month) into a UTC calendar-month period. Used by the admin close + admin view.
 */
export function resolveMonth(month: string): ResolvedPeriod {
  if (typeof month !== 'string' || (!MONTH_RE.test(month) && !DATE_RE.test(month))) {
    throw invalidInput('month must be a YYYY-MM calendar month', { field: 'month', value: month })
  }
  const [y, m] = month.split('-').map(Number)
  if (m < 1 || m > 12) {
    throw invalidInput('month must be between 01 and 12', { field: 'month', value: month })
  }
  return monthPeriod(y, m)
}

/**
 * Resolve an optional from/to query into a period. Both omitted -> current UTC month
 * (FR-11 AC1 monthly default). If one is given both must be, and from <= to.
 */
export function resolveReportPeriod(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date()
): ResolvedPeriod {
  if (!from && !to) return currentMonthPeriod(now)
  if (!from || !to) {
    throw invalidInput('from and to must be provided together', { from, to })
  }
  const startTs = parseDateOnly(from, 'from')
  const toDate = parseDateOnly(to, 'to')
  if (toDate.getTime() < startTs.getTime()) {
    throw invalidInput('from must be on or before to', { from, to })
  }
  const endTsExclusive = new Date(toDate.getTime() + 24 * 60 * 60 * 1000)
  return { from, to, startTs, endTsExclusive }
}
