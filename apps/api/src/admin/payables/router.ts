// Cerbo Admin payables routes (docs/ARCHITECTURE.md section 8, FR-11 AC3). Paths
// relative to /api/admin; mounted behind demoUser + requireRole('cerbo_admin').
//
// T8 implements the month view and month close. The close creates immutable
// payable_statements (ADR-016); the view returns the stored statements once closed, or
// a live preview before. The report aggregation itself lives in the T8-owned reports
// service - this router only validates input and does the HTTP mapping.
import { Router, type Request, type Response } from 'express'
import { db } from '../../db/knex'
import { getAdminPayables, closePayables } from '../../reports/service'
import { handleError, invalidInput } from '../../reports/errors'

export const adminPayablesRouter: Router = Router()

adminPayablesRouter.get('/payables', async (req: Request, res: Response) => {
  try {
    const month = (req.query.month as string | undefined) ?? ''
    if (!month) throw invalidInput('month query parameter is required', { field: 'month' })
    res.status(200).json(await getAdminPayables(db, month))
  } catch (err) {
    handleError(res, err)
  }
})

adminPayablesRouter.post('/payables/close', async (req: Request, res: Response) => {
  try {
    const month = (req.body?.month as string | undefined) ?? ''
    if (!month) throw invalidInput('month is required', { field: 'month' })
    const closedBy = req.actor?.id ?? null
    res.status(201).json(await closePayables(db, closedBy ?? 'unknown', month))
  } catch (err) {
    handleError(res, err)
  }
})
