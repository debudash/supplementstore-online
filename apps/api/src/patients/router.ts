// GET /api/patients (docs/ARCHITECTURE.md section 8). Returns the provider's own
// practice roster so the order builder (FR-1) can obtain real patients.id uuids.
// Mounted behind demoUser + requireRole('provider') in app.ts, so req.actor (a
// provider) is always present here. Uses the shared knex singleton (routers are
// mounted as instances).
//
// OWNERSHIP (AGENTS.md section 7): a provider sees ONLY patients in their own
// practice. We filter patients.practice_id against the actor's practiceId; the full
// table is never returned. Leaking a cross-practice patient list in a healthcare demo
// would be the worst-looking bug here, so the scope is enforced in the query itself.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { sendError } from '../http'

interface PatientRow {
  id: string
  name: string
  email: string
}

export const patientsRouter: Router = Router()

patientsRouter.get('/', async (req: Request, res: Response) => {
  const actor = req.actor!
  try {
    // A provider always has a practiceId; guard anyway so a mis-seeded actor can
    // never fall through to an unscoped query.
    if (!actor.practiceId) {
      res.status(200).json({ patients: [] })
      return
    }
    const rows = await db<PatientRow>('patients')
      .where('practice_id', actor.practiceId)
      .select('id', 'name', 'email')
      .orderBy('name')
    res.status(200).json({ patients: rows })
  } catch (err) {
    console.error('[api:error]', err)
    sendError(res, 500, 'INTERNAL', 'Internal server error')
  }
})
