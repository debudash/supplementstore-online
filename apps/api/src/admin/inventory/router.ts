// Cerbo Admin inventory routes (docs/ARCHITECTURE.md section 8). 501 stubs until T11.
// Paths are relative to /api/admin. Restock is demo-only (FR-15).
import { Router } from 'express'
import { notImplemented } from '../../http'

export const adminInventoryRouter: Router = Router()

adminInventoryRouter.get('/inventory', (_req, res) => notImplemented(res, 'GET /api/admin/inventory'))
adminInventoryRouter.post('/inventory/:sku/restock', (_req, res) =>
  notImplemented(res, 'POST /api/admin/inventory/:sku/restock')
)
