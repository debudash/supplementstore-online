// Cerbo Admin metrics route (FR-13, docs/ARCHITECTURE.md section 8). Path relative to
// /api/admin; mounted behind demoUser + requireRole('cerbo_admin'). The aggregation
// lives in the service - this router only parses query input and maps the HTTP envelope.
import { Router, type Request, type Response } from 'express'
import { db } from '../../db/knex'
import { getAdminMetrics } from './service'
import { handleError } from '../errors'

export const adminMetricsRouter: Router = Router()

/** Parse the includeSynthetic query flag: default false, "true" opts in (FR-13 AC3). */
function parseIncludeSynthetic(value: unknown): boolean {
  return value === 'true' || value === '1'
}

adminMetricsRouter.get('/metrics', async (req: Request, res: Response) => {
  try {
    const result = await getAdminMetrics(db, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      groupBy: req.query.groupBy as string | undefined,
      includeSynthetic: parseIncludeSynthetic(req.query.includeSynthetic)
    })
    res.status(200).json(result)
  } catch (err) {
    handleError(res, err)
  }
})
