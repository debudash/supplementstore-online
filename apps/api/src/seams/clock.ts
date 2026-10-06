import type { Clock } from './types'

/** Default clock: system time. Demo generators inject a fixed/backdated clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}
