// DEMO_MODE gate for the Cerbo Admin demo-only endpoints (FR-14 AC5, RT-14, EVAL-15).
//
// The synthetic baseline regenerate, migration generate, and reset endpoints are demo
// instrumentation: they must return 403 DEMO_DISABLED unless DEMO_MODE=true. The CSV
// baseline import is NOT gated here - it is the real interim import mechanism (ADR-018),
// not a demo generator, and EVAL-15 scopes the gate to /api/admin/demo/* specifically.
//
// Read at request time (not module load) so a test can flip process.env.DEMO_MODE
// between cases without re-importing the router.
import type { NextFunction, Request, Response } from 'express'
import { demoDisabled, handleError } from '../errors'

/** True only when DEMO_MODE is exactly "true" (any other value disables demo endpoints). */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true'
}

/** Express guard: reject demo-only routes with 403 DEMO_DISABLED unless DEMO_MODE=true. */
export function demoModeGuard(_req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) {
    handleError(res, demoDisabled())
    return
  }
  next()
}
