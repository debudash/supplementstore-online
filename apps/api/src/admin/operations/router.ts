// Cerbo Admin operations routes (docs/ARCHITECTURE.md section 8): fulfill, refund,
// audit, and the demo job endpoints. 501 stubs until T11 (and T4/T5 for audit/refund).
// Paths relative to /api/admin.
import { Router, type Request, type Response } from 'express'
import { notImplemented, sendError } from '../../http'
import { db } from '../../db/knex'
import { createSeams } from '../../seams'
import { loadAudit } from '../../ledger'
import { refundOrder, handleRefundError } from '../../refunds'
import { fulfillOrder } from '../../fulfillment'
import { runExpireReservations } from '../../jobs/expire'

export const adminOperationsRouter: Router = Router()

// Default seam container for runtime; tests drive the services directly with overrides.
const seams = createSeams()

// Fulfill (FR-9, T5). Cerbo Admin only (the admin router already requires the role).
adminOperationsRouter.post('/orders/:id/fulfill', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await fulfillOrder(db, req.actor!, req.params.id, seams))
  } catch (err) {
    handleRefundError(res, err)
  }
})

// Refund (FR-8, T5). Cerbo Admin can refund any order. Delegates to the T5 service.
adminOperationsRouter.post('/orders/:id/refund', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await refundOrder(db, req.actor!, req.params.id, req.body, seams))
  } catch (err) {
    handleRefundError(res, err)
  }
})

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
// Expire-reservations demo job (FR-4 AC3, EVAL-14, T11). The admin console button that
// drives a demo deterministically instead of waiting for the 60s interval timer. Thin
// wrapper over T3's runExpireReservations (idempotent, row-locked, safe to run next to
// the interval - see apps/api/src/jobs/expire.ts). Returns the ids expired this run.
adminOperationsRouter.post('/jobs/expire-reservations', async (_req: Request, res: Response) => {
  try {
    res.status(200).json(await runExpireReservations(db))
  } catch (err) {
    console.error('[api:error]', err)
    sendError(res, 500, 'INTERNAL', 'Internal server error')
  }
})

// Run-due-schedules demo job (FR-12, T11 hook / T9 engine). This endpoint is the admin
// console's hook into the recurring-order engine - the job that finds schedules whose
// next cycle is due and charges them. That engine is a SEPARATE task (T9) and is not part
// of this deployed slice, so there is nothing to run yet and we must not fake one. When
// the recurring engine ships, wiring it here is a one-line change - the handler, the
// cerbo_admin guard (parent router) and the response shape are already in place; only the
// engine call is missing:
//
//   import { runDueSchedules } from '../../jobs/recurring'   // provided by T9
//   res.status(200).json(await runDueSchedules(db))
//
// Until then, report honestly with the standard 501 envelope rather than a staged result.
adminOperationsRouter.post('/jobs/run-due-schedules', (_req, res) =>
  notImplemented(res, 'POST /api/admin/jobs/run-due-schedules')
)
