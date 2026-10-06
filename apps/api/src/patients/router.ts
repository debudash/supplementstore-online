// GET /api/patients (docs/ARCHITECTURE.md section 8). 501 stub until implemented.
// Mounted behind demoUser + requireRole('provider').
import { Router } from 'express'
import { notImplemented } from '../http'

export const patientsRouter: Router = Router()

patientsRouter.get('/', (_req, res) => notImplemented(res, 'GET /api/patients'))
