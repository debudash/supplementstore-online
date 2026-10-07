// Provider order routes (docs/ARCHITECTURE.md section 8). T3 implements the full
// lifecycle EXCEPT refund and audit, which stay 501 until T5/T4 respectively.
// Mounted at /api/orders behind demoUser + requireRole('provider') in app.ts, so a
// resolved `req.actor` (role=provider) is always present here.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { createSeams } from '../seams'
import { loadAudit } from '../ledger'
import { refundOrder, handleRefundError } from '../refunds'
import { handleError, notFound } from './errors'
import { approveRefundRequest, declineRefundRequest, getRefundRequest } from '../refund-requests/service'
import {
  createDraft,
  addLine,
  updateLine,
  deleteLine,
  getQuote,
  sendOrder,
  cancelOrder,
  deleteDraft,
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

// Delete a draft order outright (drafts hold no stock, so nothing to release).
ordersRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await deleteDraft(db, actorOf(req), req.params.id)
    res.status(204).end()
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

// Refund (FR-8, T5). The stub reserved here for T5 is now wired to the T5 refunds
// service. The service does the provider ownership check (not owned -> 404, no existence
// leak; RT-01) and runs the whole refund in one locked transaction. handleRefundError
// maps the refund-specific codes (ALREADY_REFUNDED, NOT_REFUNDABLE).
ordersRouter.post('/:id/refund', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await refundOrder(db, actorOf(req), req.params.id, req.body, seams))
  } catch (err) {
    handleRefundError(res, err)
  }
})

// Patient refund requests on the provider's own orders: view the latest, approve (runs
// the standard refund) or decline with a note the patient sees.
ordersRouter.get('/:id/refund-request', async (req: Request, res: Response) => {
  try {
    res.status(200).json({ request: await getRefundRequest(db, actorOf(req), req.params.id) })
  } catch (err) {
    handleRefundError(res, err)
  }
})
ordersRouter.post('/:id/refund-request/approve', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await approveRefundRequest(db, actorOf(req), req.params.id, req.body, seams))
  } catch (err) {
    handleRefundError(res, err)
  }
})
ordersRouter.post('/:id/refund-request/decline', async (req: Request, res: Response) => {
  try {
    res.status(200).json({ request: await declineRefundRequest(db, actorOf(req), req.params.id, req.body) })
  } catch (err) {
    handleRefundError(res, err)
  }
})

ordersRouter.get('/:id/audit', async (req: Request, res: Response) => {
  try {
    const actor = actorOf(req)
    const audit = await loadAudit(db, req.params.id)
    if (!audit || audit.order.providerId !== actor.providerId) {
      handleError(res, notFound('No such order', { orderId: req.params.id }))
      return
    }
    res.status(200).json(audit)
  } catch (err) {
    handleError(res, err)
  }
})
