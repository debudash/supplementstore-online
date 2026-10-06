// Provider order routes (docs/ARCHITECTURE.md section 8). T3 implements the full
// lifecycle EXCEPT refund and audit, which stay 501 until T5/T4 respectively.
// Mounted at /api/orders behind demoUser + requireRole('provider') in app.ts, so a
// resolved `req.actor` (role=provider) is always present here.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { createSeams } from '../seams'
import { notImplemented } from '../http'
import { handleError } from './errors'
import {
  createDraft,
  addLine,
  updateLine,
  deleteLine,
  getQuote,
  sendOrder,
  cancelOrder,
  listOrders
} from './service'

// Default seam container for runtime (app.ts mounts routers as instances, so the
// router resolves its own seams). Tests exercise the service layer directly with an
// injected Clock (e.g. for the 7-day reservation expiry).
const seams = createSeams()

export const ordersRouter: Router = Router()

const actorOf = (req: Request) => req.actor!

ordersRouter.post('/', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await createDraft(db, actorOf(req), req.body))
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { status, from, to } = req.query as Record<string, string | undefined>
    res.status(200).json({ orders: await listOrders(db, actorOf(req), { status, from, to }) })
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.post('/:id/lines', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await addLine(db, actorOf(req), req.params.id, req.body))
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.patch('/:id/lines/:lineId', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await updateLine(db, actorOf(req), req.params.id, req.params.lineId, req.body))
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.delete('/:id/lines/:lineId', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await deleteLine(db, actorOf(req), req.params.id, req.params.lineId))
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.get('/:id/quote', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await getQuote(db, actorOf(req), req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.post('/:id/send', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await sendOrder(db, actorOf(req), req.params.id, seams))
  } catch (err) {
    handleError(res, err)
  }
})

ordersRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await cancelOrder(db, actorOf(req), req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

// Owned by T5 (refund) and T4 (audit): left as 501 stubs until those tasks land.
ordersRouter.post('/:id/refund', (_req, res) => notImplemented(res, 'POST /api/orders/:id/refund'))
ordersRouter.get('/:id/audit', (_req, res) => notImplemented(res, 'GET /api/orders/:id/audit'))
