// Cerbo Admin operations routes (docs/ARCHITECTURE.md section 8): fulfill, refund,
// audit, and the demo job endpoints. 501 stubs until T11 (and T4/T5 for audit/refund).
// Paths relative to /api/admin.
import { Router, type Request, type Response } from 'express'
import { notImplemented, sendError } from '../../http'
import { db } from '../../db/knex'
import { loadAudit } from '../../ledger'

export const adminOperationsRouter: Router = Router()

adminOperationsRouter.post('/orders/:id/fulfill', (_req, res) =>
  notImplemented(res, 'POST /api/admin/orders/:id/fulfill')
)
adminOperationsRouter.post('/orders/:id/refund', (_req, res) =>
  notImplemented(res, 'POST /api/admin/orders/:id/refund')
)

// Audit is implemented by T4 (FR-7 AC1/AC2). Cerbo Admin can view ANY order, so there is
// no ownership filter here (the router already requires the cerbo_admin role). The audit
// query lives in the T4-owned ledger module; T0/T11 reserved this stub for T4.
adminOperationsRouter.get('/orders/:id/audit', async (req: Request, res: Response) => {
  try {
    const audit = await loadAudit(db, req.params.id)
    if (!audit) {
      sendError(res, 404, 'NOT_FOUND', 'No such order', { orderId: req.params.id })
      return
    }
    res.status(200).json(audit)
  } catch (err) {
    console.error('[api:error]', err)
    sendError(res, 500, 'INTERNAL', 'Internal server error')
  }
})
adminOperationsRouter.post('/jobs/expire-reservations', (_req, res) =>
  notImplemented(res, 'POST /api/admin/jobs/expire-reservations')
)
adminOperationsRouter.post('/jobs/run-due-schedules', (_req, res) =>
  notImplemented(res, 'POST /api/admin/jobs/run-due-schedules')
)
