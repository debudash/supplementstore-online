// Cerbo Admin payables routes (docs/ARCHITECTURE.md section 8). 501 stubs until T8.
// Paths relative to /api/admin.
import { Router } from 'express'
import { notImplemented } from '../../http'

export const adminPayablesRouter: Router = Router()

adminPayablesRouter.get('/payables', (_req, res) => notImplemented(res, 'GET /api/admin/payables'))
adminPayablesRouter.post('/payables/close', (_req, res) =>
  notImplemented(res, 'POST /api/admin/payables/close')
)
