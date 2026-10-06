// Provider report routes (docs/ARCHITECTURE.md section 8). 501 stubs until T8.
// Mounted at /api/reports behind demoUser + requireRole('provider').
import { Router } from 'express'
import { notImplemented } from '../http'

export const reportsRouter: Router = Router()

reportsRouter.get('/sales', (_req, res) => notImplemented(res, 'GET /api/reports/sales'))
reportsRouter.get('/payables', (_req, res) => notImplemented(res, 'GET /api/reports/payables'))
