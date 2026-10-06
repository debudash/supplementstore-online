// GET /api/products (docs/ARCHITECTURE.md section 8): sku, name, unit_cogs_cents,
// available, active. 501 stub until T3. Mounted behind demoUser + requireRole('provider').
import { Router } from 'express'
import { notImplemented } from '../http'

export const productsRouter: Router = Router()

productsRouter.get('/', (_req, res) => notImplemented(res, 'GET /api/products'))
