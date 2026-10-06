// Route registry (AGENTS.md section 5, docs/ARCHITECTURE.md section 8).
// T0 pre-registers EVERY route here. Module routers return 501 until their task
// implements them; later tasks replace only their own module file, not this file.
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'

import { demoUser } from './auth/middleware'
import { requireRole } from './auth/guards'
import type { ActorLoader } from './auth/types'
import { sendError } from './http'
import { createSeams, type Seams } from './seams'

import { ordersRouter } from './orders/router'
import { patientsRouter } from './patients/router'
import { productsRouter } from './inventory/router'
import { payRouter } from './payments/router'
import { schedulesRouter } from './recurring/router'
import { reportsRouter } from './reports/router'
import { adminInventoryRouter } from './admin/inventory/router'
import { adminMetricsRouter } from './admin/metrics/router'
import { adminPayablesRouter } from './admin/payables/router'
import { adminOperationsRouter } from './admin/operations/router'
import { adminDemoRouter } from './admin/demo/router'

export interface AppDeps {
  db: Knex
  loadActor: ActorLoader
  seams?: Seams
}

/**
 * Build the Express app with injected dependencies so tests can supply a fake
 * actor loader and db. The HTTP shell owns auth wiring; business logic lives in
 * the module routers.
 */
export function createApp(deps: AppDeps): Express {
  const { db, loadActor } = deps
  // Seams are resolved here so they are available to business modules as they land.
  const seams: Seams = deps.seams ?? createSeams()
  void seams

  const app = express()
  app.use(express.json())

  // Health (FR-17 AC2): 200 with DB connectivity status; 503 if the DB is down.
  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await db.raw('select 1')
      res.status(200).json({ status: 'ok', db: { connected: true } })
    } catch (err) {
      res.status(503).json({
        status: 'error',
        db: { connected: false, error: (err as Error).message }
      })
    }
  })

  const auth = demoUser(loadActor)

  // Provider surface (own practice data only; ownership checks per route in later tasks).
  app.use('/api/products', auth, requireRole('provider'), productsRouter)
  app.use('/api/patients', auth, requireRole('provider'), patientsRouter)
  app.use('/api/orders', auth, requireRole('provider'), ordersRouter)
  app.use('/api/schedules', auth, requireRole('provider'), schedulesRouter)
  app.use('/api/reports', auth, requireRole('provider'), reportsRouter)

  // Patient surface: token-based, NO X-Demo-User (AGENTS.md section 7).
  app.use('/api/pay', payRouter)

  // Cerbo Admin surface. All admin sub-routers mount at /api/admin.
  const admin = express.Router()
  admin.use(adminInventoryRouter)
  admin.use(adminMetricsRouter)
  admin.use(adminPayablesRouter)
  admin.use(adminOperationsRouter)
  admin.use(adminDemoRouter)
  app.use('/api/admin', auth, requireRole('cerbo_admin'), admin)

  // Unknown API route -> 404 in the standard error shape.
  app.use('/api', (_req: Request, res: Response) => {
    sendError(res, 404, 'NOT_FOUND', 'No such API route')
  })

  // Central error handler keeps the error envelope consistent.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api:error]', err)
    sendError(res, 500, 'INTERNAL', 'Internal server error')
  })

  return app
}
