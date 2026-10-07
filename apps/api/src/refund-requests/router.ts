// Provider refund review link (ADR-027): /api/refund-review/:token. Like a pay link, the
// token identifies the request; unlike a pay link, the API still requires the provider who
// owns the order (mounted behind demoUser + requireRole('provider')), because accepting
// moves money. Accept refunds immediately through the standard refund path.
import { Router, type Request, type Response } from 'express'
import { db } from '../db/knex'
import { createSeams } from '../seams'
import { handleRefundError } from '../refunds'
import { acceptReview, declineReview, getReview } from './service'

const seams = createSeams()
export const refundReviewRouter: Router = Router()

refundReviewRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await getReview(db, req.actor!, req.params.token))
  } catch (err) {
    handleRefundError(res, err)
  }
})

refundReviewRouter.post('/:token/accept', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await acceptReview(db, req.actor!, req.params.token, req.body, seams))
  } catch (err) {
    handleRefundError(res, err)
  }
})

refundReviewRouter.post('/:token/decline', async (req: Request, res: Response) => {
  try {
    res.status(200).json({ request: await declineReview(db, req.actor!, req.params.token, req.body) })
  } catch (err) {
    handleRefundError(res, err)
  }
})
