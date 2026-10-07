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
import { patientOrdersRouter } from './patient-orders/router'
import { schedulesRouter } from './recurring/router'
import { reportsRouter } from './reports/router'
import { adminInventoryRouter } from './admin/inventory/router'
import { adminMetricsRouter } from './admin/metrics/router'
import { adminPayablesRouter } from './admin/payables/router'
import { adminOperationsRouter } from './admin/operations/router'
import { adminDemoRouter } from './admin/demo/router'
import { adminPricingRouter } from './admin/pricing/router'

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

  // Health (FR-17 AC2) doubles as the deploy readiness gate (Railway healthcheck + the CI
  // post-deploy poll). 200 only when the DB answers AND the catalog is migrated and
  // seeded; 503 'degraded' when connected but the catalog is missing or empty (e.g. an
  // unmigrated or wiped database), 503 'error' when the DB is unreachable. Boot migrates
  // and seeds before listening, so a healthy deploy is never reported as degraded.
  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await db.raw('select 1')
    } catch (err) {
      res.status(503).json({ status: 'error', db: { connected: false, error: (err as Error).message } })
      return
    }
    let products = 0
    try {
      const result = await db.raw('select count(*)::int as n from products')
      products = Number(result?.rows?.[0]?.n ?? 0)
    } catch {
      products = 0 // products table missing: migrations have not run
    }
    const ready = products > 0
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      db: { connected: true },
      catalog: { ready, products }
    })
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

  // Patient "My Orders" listing: a SEPARATE role-guarded, ownership-scoped surface so a
  // patient can find the pay link for their own orders. This does NOT weaken the token
  // model above - payment still happens at /api/pay/:token; this only lists the caller's
  // own orders (service filters to actor.patientId).
  app.use('/api/patient', auth, requireRole('patient'), patientOrdersRouter)

  // Cerbo Admin surface. All admin sub-routers mount at /api/admin.
  const admin = express.Router()
  admin.use(adminInventoryRouter)
  admin.use(adminMetricsRouter)
  admin.use(adminPayablesRouter)
  admin.use(adminOperationsRouter)
  admin.use(adminDemoRouter)
  admin.use(adminPricingRouter)
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
