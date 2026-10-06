// Cerbo Admin operations routes (docs/ARCHITECTURE.md section 8): fulfill, refund,
// audit, and the demo job endpoints. 501 stubs until T11 (and T4/T5 for audit/refund).
// Paths relative to /api/admin.
import { Router } from 'express'
import { notImplemented } from '../../http'

export const adminOperationsRouter: Router = Router()

adminOperationsRouter.post('/orders/:id/fulfill', (_req, res) =>
  notImplemented(res, 'POST /api/admin/orders/:id/fulfill')
)
adminOperationsRouter.post('/orders/:id/refund', (_req, res) =>
  notImplemented(res, 'POST /api/admin/orders/:id/refund')
)
adminOperationsRouter.get('/orders/:id/audit', (_req, res) =>
  notImplemented(res, 'GET /api/admin/orders/:id/audit')
)
adminOperationsRouter.post('/jobs/expire-reservations', (_req, res) =>
  notImplemented(res, 'POST /api/admin/jobs/expire-reservations')
)
adminOperationsRouter.post('/jobs/run-due-schedules', (_req, res) =>
  notImplemented(res, 'POST /api/admin/jobs/run-due-schedules')
)
