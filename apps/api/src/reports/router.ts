// Provider report routes (docs/ARCHITECTURE.md section 8, FR-10 / FR-11).
// Mounted at /api/reports behind demoUser + requireRole('provider') in app.ts, so a
// resolved req.actor (role=provider) is always present. Reports are provider-scoped:
// every figure is filtered to actor.providerId, so provider A never sees provider B's
// numbers (the ownership rule, AGENTS.md section 7).
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { getSalesReport, getPayableReport } from './service'
import { handleError, invalidInput } from './errors'

export const reportsRouter: Router = Router()

/** Parse the optional includeSynthetic query flag (default false). */
function parseIncludeSynthetic(raw: unknown): boolean {
  return raw === 'true' || raw === '1'
}

/** The signed-in provider's id, or a 400 if the actor is somehow not a provider. */
function providerIdOf(req: Request): string {
  const id = req.actor?.providerId
  if (!id) throw invalidInput('No provider is associated with this user')
  return id
}

reportsRouter.get('/sales', async (req: Request, res: Response) => {
  try {
    const { from, to, includeSynthetic } = req.query as Record<string, string | undefined>
    const report = await getSalesReport(db, providerIdOf(req), {
      from,
      to,
      includeSynthetic: parseIncludeSynthetic(includeSynthetic)
    })
    res.status(200).json(report)
  } catch (err) {
    handleError(res, err)
  }
})

reportsRouter.get('/payables', async (req: Request, res: Response) => {
  try {
    const { from, to, includeSynthetic } = req.query as Record<string, string | undefined>
    const report = await getPayableReport(db, providerIdOf(req), {
      from,
      to,
      includeSynthetic: parseIncludeSynthetic(includeSynthetic)
    })
    res.status(200).json(report)
  } catch (err) {
    handleError(res, err)
  }
})
