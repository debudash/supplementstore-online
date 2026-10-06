// Recurring schedule routes (docs/ARCHITECTURE.md section 8). 501 stubs until T9.
// Mounted at /api/schedules behind demoUser + requireRole('provider').
import { Router } from 'express'
import { notImplemented } from '../http'

export const schedulesRouter: Router = Router()

schedulesRouter.post('/', (_req, res) => notImplemented(res, 'POST /api/schedules'))
schedulesRouter.get('/', (_req, res) => notImplemented(res, 'GET /api/schedules'))
schedulesRouter.post('/:id/pause', (_req, res) => notImplemented(res, 'POST /api/schedules/:id/pause'))
schedulesRouter.post('/:id/resume', (_req, res) =>
  notImplemented(res, 'POST /api/schedules/:id/resume')
)
schedulesRouter.post('/:id/cancel', (_req, res) =>
  notImplemented(res, 'POST /api/schedules/:id/cancel')
)
schedulesRouter.post('/:id/run', (_req, res) => notImplemented(res, 'POST /api/schedules/:id/run'))
