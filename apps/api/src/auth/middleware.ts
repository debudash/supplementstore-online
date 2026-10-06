// Demo-user middleware: resolves the actor from the X-Demo-User header
// (AGENTS.md section 7). Unknown or missing user -> 401. Patient token routes
// (/api/pay/*) do NOT use this middleware.
import type { NextFunction, Request, Response } from 'express'
import { sendError } from '../http'
import type { ActorLoader } from './types'

export const DEMO_USER_HEADER = 'x-demo-user'

/**
 * Build the demo-user middleware around an actor loader. The loader is injected
 * so tests can run without a database.
 */
export function demoUser(loadActor: ActorLoader) {
  return async function demoUserMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const raw = req.header(DEMO_USER_HEADER)
    const userId = typeof raw === 'string' ? raw.trim() : ''
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Missing X-Demo-User header')
      return
    }
    try {
      const actor = await loadActor(userId)
      if (!actor) {
        sendError(res, 401, 'UNAUTHENTICATED', 'Unknown user')
        return
      }
      req.actor = actor
      next()
    } catch (err) {
      next(err)
    }
  }
}
