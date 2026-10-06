// Cerbo Admin inventory routes (docs/ARCHITECTURE.md section 8) - T11, FR-15, ADR-009.
//
// Paths are relative to /api/admin. The parent admin router already requires the
// cerbo_admin role, so a provider calling these gets 403 FORBIDDEN (RT-09) before the
// handler runs - there is deliberately no extra ownership check because Cerbo owns the
// single shared pool. Restock is demo-only (FR-15); the UI labels it so.
import { Router, type Request, type Response } from 'express'
import { db } from '../../db/knex'
import { handleError } from '../../orders/errors'
import { listInventory, restock } from './service'

export const adminInventoryRouter: Router = Router()

adminInventoryRouter.get('/inventory', async (_req: Request, res: Response) => {
  try {
    res.status(200).json({ items: await listInventory(db) })
  } catch (err) {
    handleError(res, err)
  }
})

adminInventoryRouter.post('/inventory/:sku/restock', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await restock(db, req.actor!, req.params.sku, req.body))
  } catch (err) {
    handleError(res, err)
  }
})
