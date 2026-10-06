// Cerbo Admin baseline + demo data routes (docs/ARCHITECTURE.md section 8).
// 501 stubs until T10. Paths relative to /api/admin. All demo endpoints must
// return DEMO_DISABLED unless DEMO_MODE=true (FR-14 AC5) - enforced by T10.
import { Router } from 'express'
import { notImplemented } from '../../http'

export const adminDemoRouter: Router = Router()

adminDemoRouter.post('/baseline/import', (_req, res) =>
  notImplemented(res, 'POST /api/admin/baseline/import')
)
adminDemoRouter.post('/demo/baseline/regenerate', (_req, res) =>
  notImplemented(res, 'POST /api/admin/demo/baseline/regenerate')
)
adminDemoRouter.post('/demo/migration/generate', (_req, res) =>
  notImplemented(res, 'POST /api/admin/demo/migration/generate')
)
adminDemoRouter.post('/demo/reset', (_req, res) => notImplemented(res, 'POST /api/admin/demo/reset'))
