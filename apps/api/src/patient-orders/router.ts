// Patient "My Orders" route. Mounted at /api/patient behind demoUser + requireRole
// ('patient') in app.ts. Ownership scoping lives in the service (orders are filtered to
// actor.patientId). This is a listing surface only; payment stays at /api/pay/:token.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { handleError } from '../orders/errors'
import { listPatientOrders } from './service'
import { createRefundRequest } from '../refund-requests/service'

export const patientOrdersRouter: Router = Router()

// POST /api/patient/orders/:id/refund-request - ask the provider for a refund on one of
// the caller's own paid orders (no return; ADR-023). { reasonCode, note? }
patientOrdersRouter.post('/orders/:id/refund-request', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await createRefundRequest(db, req.actor!, req.params.id, req.body))
  } catch (err) {
    handleError(res, err)
  }
})

// GET /api/patient/orders - the calling patient's own orders, with their pay links.
patientOrdersRouter.get('/orders', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await listPatientOrders(db, req.actor!))
  } catch (err) {
    handleError(res, err)
  }
})
