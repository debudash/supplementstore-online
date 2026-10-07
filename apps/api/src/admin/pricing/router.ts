// Cerbo Admin list-price routes (ADR-025). Paths are relative to /api/admin; the parent
// admin router already requires the cerbo_admin role, so a provider gets 403 (RT-09).
import { Router, type Request, type Response } from 'express'
import { db } from '../../db/knex'
import { handleError } from '../../orders/errors'
import { previewListPrice, priceHistory, updateListPrice } from './service'

export const adminPricingRouter: Router = Router()

adminPricingRouter.get('/products/:sku/list-price-preview', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await previewListPrice(db, req.params.sku, req.query.listPriceCents))
  } catch (err) {
    handleError(res, err)
  }
})

adminPricingRouter.patch('/products/:sku/list-price', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await updateListPrice(db, req.actor!, req.params.sku, req.body))
  } catch (err) {
    handleError(res, err)
  }
})

adminPricingRouter.get('/products/:sku/price-history', async (req: Request, res: Response) => {
  try {
    res.status(200).json({ sku: req.params.sku, changes: await priceHistory(db, req.params.sku) })
  } catch (err) {
    handleError(res, err)
  }
})
