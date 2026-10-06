// Cerbo Admin metrics route (docs/ARCHITECTURE.md section 8). 501 stub until T10.
// Path is relative to /api/admin.
import { Router } from 'express'
import { notImplemented } from '../../http'

export const adminMetricsRouter: Router = Router()

adminMetricsRouter.get('/metrics', (_req, res) => notImplemented(res, 'GET /api/admin/metrics'))
