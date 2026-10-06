// Patient "My Orders" route. Mounted at /api/patient behind demoUser + requireRole
// ('patient') in app.ts. Ownership scoping lives in the service (orders are filtered to
// actor.patientId). This is a listing surface only; payment stays at /api/pay/:token.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { handleError } from '../orders/errors'
import { listPatientOrders } from './service'

export const patientOrdersRouter: Router = Router()

// GET /api/patient/orders - the calling patient's own orders, with their pay links.
patientOrdersRouter.get('/orders', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await listPatientOrders(db, req.actor!))
  } catch (err) {
    handleError(res, err)
  }
})
