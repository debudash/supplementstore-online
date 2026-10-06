// Recurring schedule routes (T9, docs/ARCHITECTURE.md section 8, FR-12).
// Mounted at /api/schedules behind demoUser + requireRole('provider') in app.ts, so a
// resolved `req.actor` (role=provider) is always present here. Ownership (schedule
// belongs to this provider) is enforced in the service: not owned -> 404 (no leak).
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { createSeams } from '../seams'
import { handleError } from './errors'
import {
  createSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  cancelSchedule,
  runScheduleById
} from './service'

// Default seam container for runtime; tests drive the service directly with overrides
// (e.g. a declining gateway, or a fixed Clock for the due-gate).
const seams = createSeams()

export const schedulesRouter: Router = Router()

const actorOf = (req: Request) => req.actor!

schedulesRouter.post('/', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await createSchedule(db, actorOf(req), req.body))
  } catch (err) {
    handleError(res, err)
  }
})

schedulesRouter.get('/', async (req: Request, res: Response) => {
  try {
    res.status(200).json({ schedules: await listSchedules(db, actorOf(req)) })
  } catch (err) {
    handleError(res, err)
  }
})

schedulesRouter.post('/:id/pause', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await pauseSchedule(db, actorOf(req), req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

schedulesRouter.post('/:id/resume', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await resumeSchedule(db, actorOf(req), req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

schedulesRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await cancelSchedule(db, actorOf(req), req.params.id))
  } catch (err) {
    handleError(res, err)
  }
})

schedulesRouter.post('/:id/run', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await runScheduleById(db, actorOf(req), req.params.id, seams))
  } catch (err) {
    handleError(res, err)
  }
})
