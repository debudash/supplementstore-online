// Fulfillment service (T5) - FR-9. Cerbo Admin marks a PAID order fulfilled through the
// FulfillmentService seam (a stub in this slice). Fulfillment is a flag on a paid order,
// not a status change (docs/ARCHITECTURE.md section 6): the order stays `paid` and gains
// a `fulfilled_at` timestamp. Refunded (and any non-paid) orders cannot be fulfilled
// (FR-9 AC2).
//
// It matters downstream for refunds (ADR-013): a refund AFTER fulfillment writes off the
// COGS instead of restocking.
import type { Knex } from 'knex'
import type { FulfillResult } from '@cerbo/contracts'
import type { Actor } from '../auth/types'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { notFound, notFulfillable } from '../refunds/errors'

interface OrderRow {
  id: string
  status: string
  fulfilled_at: Date | null
}

/**
 * Mark a paid order fulfilled (FR-9). One transaction with a row lock on the order.
 * Cerbo Admin only (the route guards the role); there is no ownership filter because
 * admin can act on any order. Idempotent: fulfilling an already-fulfilled order returns
 * the existing timestamp without calling the seam again.
 */
export async function fulfillOrder(
  db: Knex,
  actor: Actor,
  orderId: string,
  seams: Seams = createSeams()
): Promise<FulfillResult> {
  // Defensive: only Cerbo Admin fulfils. A non-admin 404s so existence is not leaked.
  if (actor.role !== 'cerbo_admin') throw notFound('No such order', { orderId })
  const now = seams.clock.now()

  return db.transaction(async (trx) => {
    const order = await trx<OrderRow>('orders').where('id', orderId).forUpdate().first()
    if (!order) throw notFound('No such order', { orderId })

    // FR-9 AC1/AC2: only a paid order can be fulfilled; `refunded` (and every other
    // non-paid status) is rejected by this single guard.
    if (order.status !== 'paid') throw notFulfillable(order.status)

    // Idempotent: already fulfilled -> return the existing timestamp, no second call.
    if (order.fulfilled_at !== null) {
      return {
        orderId: order.id,
        status: order.status as FulfillResult['status'],
        fulfilledAt: new Date(order.fulfilled_at).toISOString()
      }
    }

    await seams.fulfillment.markFulfilled(order.id)

    await trx('orders').where({ id: order.id }).update({ fulfilled_at: now, updated_at: now })

    return {
      orderId: order.id,
      status: order.status as FulfillResult['status'],
      fulfilledAt: now.toISOString()
    }
  })
}
