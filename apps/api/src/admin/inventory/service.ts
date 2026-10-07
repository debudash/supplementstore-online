// Cerbo Admin inventory service (T11) - FR-15, ADR-009.
//
// Cerbo owns ONE shared inventory pool (ADR-009). Restock is a DEMO-ONLY convenience so a
// demo can refill stock between scenarios; in production stock arrives through real
// receiving, never a provider. A provider must NEVER restock - that is enforced upstream
// by the cerbo_admin role guard on every /api/admin/* route (RT-09), so this module only
// ever runs for an admin actor and simply records who did it.
//
// Every change writes an inventory_movements row with a reason from the schema enum; a
// restock uses reason 'restock', delta_on_hand = +qty, delta_reserved = 0 (reserved is
// untouched; docs/ARCHITECTURE.md section 6). The product row is locked FOR UPDATE so a
// restock never races a concurrent reserve/release on the same SKU (AGENTS.md money
// rule 8 row-lock discipline, mirrored from the T3 inventory service and T5 refund
// restock). This module declares its own row types to stay in step with
// apps/api/src/inventory/service.ts (the contracts package exports only its index barrel).
import type { Knex } from 'knex'
import type { AdminInventoryItem, RestockResult } from '@cerbo/contracts'
import type { Actor } from '../../auth/types'
import { assertSafeInteger } from '../../db/types'
import { invalidInput, notFound } from '../../orders/errors'

interface ProductRow {
  sku: string
  name: string
  unit_cogs_cents: number
  on_hand_qty: number
  reserved_qty: number
  active: boolean
}

/** Largest restock we accept in one call. A demo refills tens of units, not millions;
 * the cap keeps an obvious fat-finger (or a client sending junk) out of the pool. */
const MAX_RESTOCK_QTY = 10000

/** List the whole shared pool with the full on-hand / reserved / available breakdown
 * (GET /api/admin/inventory). Admin sees more than the provider catalog: both raw
 * counts, not just `available`. */
export async function listInventory(db: Knex): Promise<AdminInventoryItem[]> {
  const rows = await db<ProductRow>('products').select('*').orderBy('sku')
  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    unitCogsCents: r.unit_cogs_cents,
    onHandQty: r.on_hand_qty,
    reservedQty: r.reserved_qty,
    available: r.on_hand_qty - r.reserved_qty,
    active: r.active
  }))
}

/** Validate the restock body: qty must be a positive safe integer within the cap. */
function parseQty(body: unknown): number {
  const raw = (body ?? {}) as Record<string, unknown>
  const qty = raw.qty
  if (typeof qty !== 'number' || !Number.isInteger(qty)) {
    throw invalidInput('qty must be an integer number of units', { qty })
  }
  if (qty < 1 || qty > MAX_RESTOCK_QTY) {
    throw invalidInput(`qty must be between 1 and ${MAX_RESTOCK_QTY}`, { qty, max: MAX_RESTOCK_QTY })
  }
  assertSafeInteger(qty)
  return qty
}

/**
 * Restock one SKU in the shared pool (FR-15, demo only). Adds `qty` to on_hand under a
 * products row lock, records a single `restock` inventory movement attributed to the
 * acting Cerbo Admin, and returns the SKU's new counts. 404 if the SKU does not exist;
 * 400 if qty is not a positive integer within the cap. One transaction so the increment
 * and its movement row commit together.
 */
export async function restock(
  db: Knex,
  actor: Actor,
  sku: string,
  body: unknown
): Promise<RestockResult> {
  const qty = parseQty(body)

  return db.transaction(async (trx) => {
    const product = await trx<ProductRow>('products').where({ sku }).forUpdate().first()
    if (!product) throw notFound('No such product', { sku })

    await trx('products').where({ sku }).increment('on_hand_qty', qty).update({ updated_at: trx.fn.now() })

    const [movement] = await trx('inventory_movements')
      .insert({
        sku,
        delta_on_hand: qty,
        delta_reserved: 0,
        reason: 'restock',
        order_id: null,
        actor_user_id: actor.id
      })
      .returning<{ id: number }[]>('id')

    const onHandQty = product.on_hand_qty + qty
    return {
      sku,
      qtyAdded: qty,
      onHandQty,
      reservedQty: product.reserved_qty,
      available: onHandQty - product.reserved_qty,
      movementId: movement.id
    }
  })
}
