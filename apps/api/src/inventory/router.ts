// GET /api/products (docs/ARCHITECTURE.md section 8): sku, name, unit_cogs_cents,
// available, active. Mounted behind demoUser + requireRole('provider') in app.ts.
// Uses the shared knex singleton (app.ts wires routers as instances, so modules
// resolve their own db).
import { Router } from 'express'
import { db } from '../db/knex'
import { handleError } from '../orders/errors'
import { listProducts } from './service'

export const productsRouter: Router = Router()

productsRouter.get('/', async (_req, res) => {
  try {
    const products = await listProducts(db)
    res.status(200).json({ products })
  } catch (err) {
    handleError(res, err)
  }
})
