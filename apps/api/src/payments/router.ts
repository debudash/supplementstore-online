// Patient token routes (docs/ARCHITECTURE.md section 8). NO X-Demo-User - access
// is via the unguessable pay token. 501 stubs until T4 (pay) and T9 (schedule auth).
// Mounted at /api/pay in app.ts with NO auth middleware.
import { Router } from 'express'
import { notImplemented } from '../http'

export const payRouter: Router = Router()

payRouter.get('/schedule/:token', (_req, res) =>
  notImplemented(res, 'GET /api/pay/schedule/:token')
)
payRouter.post('/schedule/:token/authorize', (_req, res) =>
  notImplemented(res, 'POST /api/pay/schedule/:token/authorize')
)
payRouter.get('/:token', (_req, res) => notImplemented(res, 'GET /api/pay/:token'))
payRouter.post('/:token', (_req, res) => notImplemented(res, 'POST /api/pay/:token'))
