// Reservation expiry sweep (FR-4 AC3, EVAL-14, docs/ARCHITECTURE.md section 10).
//
// A `sent` order whose `reservation_expires_at` has passed is moved to `expired` and
// its reserved stock released. The job is idempotent and safe to run concurrently:
// each order is re-read FOR UPDATE and guarded on status, and the stock release takes
// the products row lock, so a second run (or the admin endpoint firing at the same
// time as the interval timer) can never double-release.
import type { Knex } from 'knex'
import type { Clock } from '../seams/types'
import { SystemClock } from '../seams'
import { releaseLines } from '../inventory/service'

interface LineRow {
  sku: string
  qty: number
}

interface LockedOrder {
  id: string
  status: string
  reservation_expires_at: Date | null
}

/**
 * Expire every `sent` order whose reservation has lapsed as of `clock.now()`.
 * Returns the ids of the orders that were expired this run.
 */
export async function runExpireReservations(
  db: Knex,
  clock: Clock = new SystemClock()
): Promise<{ expired: string[] }> {
  const now = clock.now()

  // Candidate ids first (cheap, unlocked). Each is then processed in its own
  // transaction with a row lock + status re-check, so the set can change under us
  // without causing a double-release.
  const candidates = await db('orders')
    .where('status', 'sent')
    .andWhere('reservation_expires_at', '<=', now)
    .select('id')

  const expired: string[] = []
  for (const { id } of candidates as Array<{ id: string }>) {
    const didExpire = await db.transaction(async (trx) => {
      const order = (await trx('orders').where('id', id).forUpdate().first()) as LockedOrder | undefined
      // Re-check under the lock: another worker may have paid, cancelled, or already
      // expired it since we listed candidates.
      if (!order || order.status !== 'sent') return false
      if (!order.reservation_expires_at || new Date(order.reservation_expires_at) > now) return false

      const lines = await trx<LineRow>('order_lines').where('order_id', id).orderBy('position')
      await releaseLines(
        trx,
        lines.map((l) => ({ sku: l.sku, qty: l.qty })),
        null,
        id
      )
      await trx('orders').where({ id }).update({ status: 'expired', expired_at: now, updated_at: now })
      await trx('order_events').insert({
        order_id: id,
        from_status: 'sent',
        to_status: 'expired',
        actor_user_id: null,
        note: 'reservation expired'
      })
      return true
    })
    if (didExpire) expired.push(id)
  }

  return { expired }
}
