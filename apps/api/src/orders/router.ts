// Provider order routes (docs/ARCHITECTURE.md section 8). 501 stubs until T3/T4/T5.
// Mounted at /api/orders behind demoUser + requireRole('provider') in app.ts.
import { Router } from 'express'
import { notImplemented } from '../http'

export const ordersRouter: Router = Router()

ordersRouter.post('/', (_req, res) => notImplemented(res, 'POST /api/orders'))
ordersRouter.get('/', (_req, res) => notImplemented(res, 'GET /api/orders'))
ordersRouter.post('/:id/lines', (_req, res) => notImplemented(res, 'POST /api/orders/:id/lines'))
ordersRouter.patch('/:id/lines/:lineId', (_req, res) =>
  notImplemented(res, 'PATCH /api/orders/:id/lines/:lineId')
)
ordersRouter.delete('/:id/lines/:lineId', (_req, res) =>
  notImplemented(res, 'DELETE /api/orders/:id/lines/:lineId')
)
ordersRouter.get('/:id/quote', (_req, res) => notImplemented(res, 'GET /api/orders/:id/quote'))
ordersRouter.post('/:id/send', (_req, res) => notImplemented(res, 'POST /api/orders/:id/send'))
ordersRouter.post('/:id/cancel', (_req, res) => notImplemented(res, 'POST /api/orders/:id/cancel'))
ordersRouter.post('/:id/refund', (_req, res) => notImplemented(res, 'POST /api/orders/:id/refund'))
ordersRouter.get('/:id/audit', (_req, res) => notImplemented(res, 'GET /api/orders/:id/audit'))
