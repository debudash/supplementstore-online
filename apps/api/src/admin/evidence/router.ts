// GET /api/admin/evidence (read-only). Relative to /api/admin; cerbo_admin only.
import { Router, type Request, type Response } from 'express'
import { db } from '../../db/knex'
import { handleError } from '../errors'
import { getEvidence } from './service'

export const adminEvidenceRouter: Router = Router()

adminEvidenceRouter.get('/evidence', async (req: Request, res: Response) => {
  try {
    res.status(200).json(
      await getEvidence(db, {
        includeSynthetic: req.query.includeSynthetic === 'true' || req.query.includeSynthetic === '1',
        processingRateBps: req.query.processingRateBps,
        processingFixedCents: req.query.processingFixedCents
      })
    )
  } catch (err) {
    handleError(res, err)
  }
})
