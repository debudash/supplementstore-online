// Patient token routes (docs/ARCHITECTURE.md section 8). NO X-Demo-User - access is
// via the unguessable pay token in the URL (AGENTS.md section 7). Mounted at /api/pay
// in app.ts with NO auth middleware.
//
// T4 implements GET/POST /:token (patient pay). The schedule routes stay 501 until T9.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { createSeams } from '../seams'
import { getPayView, pay } from './service'
import { handlePaymentError } from './errors'
import { getScheduleAuthorizeView, authorizeSchedule } from '../recurring/service'
import { handlePatientError } from '../recurring/errors'

// Default seam container for runtime. Tests drive the service layer directly with an
// injected gateway (e.g. to force a decline) or clock.
const seams = createSeams()

export const payRouter: Router = Router()

// Recurring schedule authorization (T9, FR-12 AC2). Token route, patient-safe whitelist
// (no economics). Delegates to the recurring service; T0/T4 reserved these two stubs.
payRouter.get('/schedule/:token', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await getScheduleAuthorizeView(db, req.params.token))
  } catch (err) {
    handlePatientError(res, err)
  }
})
payRouter.post('/schedule/:token/authorize', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await authorizeSchedule(db, req.params.token, seams))
  } catch (err) {
    handlePatientError(res, err)
  }
})

// GET /api/pay/:token - patient-safe view (FR-5 AC1, EVAL-12). Whitelisted fields only.
payRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await getPayView(db, req.params.token))
  } catch (err) {
    handlePaymentError(res, err)
  }
})

// POST /api/pay/:token - pay the order (FR-5). Idempotent; ignores client amounts.
payRouter.post('/:token', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await pay(db, req.params.token, req.body, seams))
  } catch (err) {
    handlePaymentError(res, err)
  }
})
