// Role guard (AGENTS.md section 7): every route declares allowed roles.
// Ownership checks (resource not owned -> 404) are implemented per route by
// later tasks; this guard only enforces the role.
import type { NextFunction, Request, Response } from 'express'
import { sendError } from '../http'
import type { Role } from './types'

/**
 * Require that the resolved actor has one of the given roles. Must run after
 * `demoUser`. Wrong role -> 403 FORBIDDEN.
 */
export function requireRole(...roles: Role[]) {
  return function roleGuard(req: Request, res: Response, next: NextFunction): void {
    const actor = req.actor
    if (!actor) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Not authenticated')
      return
    }
    if (!roles.includes(actor.role)) {
      sendError(res, 403, 'FORBIDDEN', 'Your role may not access this resource', {
        requiredRoles: roles
      })
      return
    }
    next()
  }
}
