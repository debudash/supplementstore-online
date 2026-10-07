// Cerbo Admin catalog list-price management (ADR-025).
//
// Only Cerbo Admin changes a product's LIST PRICE (the price the order builder starts
// from). Providers never type a price; in an order they can only move it via margin %.
//
// Risk controls on every edit:
//  - role: /api/admin/* already requires cerbo_admin (RT-09).
//  - optimistic concurrency: the caller sends the price they saw
//    (expectedCurrentPriceCents); if it changed meanwhile the edit is refused with
//    PRICE_CONFLICT instead of silently overwriting another admin's change.
//  - floor: the new price must be ABOVE Cerbo's unit cost (PRICE_BELOW_COST otherwise),
//    so a list-price order can never start at a loss.
//  - cap: at most MAX_LIST_PRICE_CENTS, a sanity bound well inside the integer column.
//  - audit: a required reason, and an append-only product_price_changes row written in
//    the SAME transaction as the price update, under a products row lock.
//
// Blast radius (surfaced to the admin before saving): drafts and sent orders keep the
// price already on their lines; ACTIVE recurring schedules price each new cycle from the
// catalog (ADR-024), so they pick up the new price on their next cycle.
import type { Knex } from 'knex'
import { marginBpsFromPrice } from '@cerbo/money'
import type { Actor } from '../../auth/types'
import { ApiError, invalidInput, notFound } from '../../orders/errors'
import { requireInt } from '../../orders/validation'

/** $100,000.00 - far above any supplement price; keeps fat-fingered values out. */
export const MAX_LIST_PRICE_CENTS = 10_000_000
const REASON_MIN = 3
const REASON_MAX = 500
const HISTORY_LIMIT = 50

interface ProductRow {
  sku: string
  name: string
  unit_cogs_cents: number
  list_price_cents: number
}

interface PriceChangeRow {
  id: string | number
  sku: string
  old_price_cents: number
  new_price_cents: number
  reason: string
  actor_user_id: string
  changed_at: Date
  actor_name?: string | null
}

export interface PriceChangeView {
  id: number
  sku: string
  oldPriceCents: number
  newPriceCents: number
  reason: string
  actorUserId: string
  actorName: string | null
  changedAt: string
}

export interface ListPriceUpdateResult {
  sku: string
  name: string
  unitCogsCents: number
  previousPriceCents: number
  listPriceCents: number
  previousMarginBps: number
  listMarginBps: number
  activeScheduleCount: number
  change: PriceChangeView
}

function toChangeView(r: PriceChangeRow): PriceChangeView {
  return {
    id: Number(r.id),
    sku: r.sku,
    oldPriceCents: r.old_price_cents,
    newPriceCents: r.new_price_cents,
    reason: r.reason,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name ?? null,
    changedAt: new Date(r.changed_at).toISOString()
  }
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('reason is required', { field: 'reason' })
  const reason = value.trim()
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    throw invalidInput(`reason must be ${REASON_MIN} to ${REASON_MAX} characters`, {
      field: 'reason',
      min: REASON_MIN,
      max: REASON_MAX
    })
  }
  return reason
}

/** Active recurring schedules that include each SKU (they reprice on their next cycle). */
export async function activeScheduleCounts(db: Knex, skus?: string[]): Promise<Map<string, number>> {
  let q = db('schedule_lines as sl')
    .join('recurring_schedules as rs', 'rs.id', 'sl.schedule_id')
    .where('rs.status', 'active')
    .groupBy('sl.sku')
    .select('sl.sku')
    .countDistinct<{ sku: string; n: string }[]>({ n: 'sl.schedule_id' })
  if (skus) q = q.whereIn('sl.sku', skus)
  const rows = await q
  return new Map(rows.map((r) => [r.sku, Number(r.n)]))
}

/**
 * PATCH /api/admin/products/:sku/list-price
 * Body: { listPriceCents, expectedCurrentPriceCents, reason }
 */
export async function updateListPrice(
  db: Knex,
  actor: Actor,
  sku: string,
  body: unknown
): Promise<ListPriceUpdateResult> {
  const b = (body ?? {}) as Record<string, unknown>
  const listPriceCents = requireInt(b.listPriceCents, 'listPriceCents', 1, MAX_LIST_PRICE_CENTS)
  const expected = requireInt(b.expectedCurrentPriceCents, 'expectedCurrentPriceCents', 1, MAX_LIST_PRICE_CENTS)
  const reason = parseReason(b.reason)

  const result = await db.transaction(async (trx) => {
    const product = await trx<ProductRow>('products').where({ sku }).forUpdate().first()
    if (!product) throw notFound('No such product', { sku })

    if (product.list_price_cents !== expected) {
      throw new ApiError('PRICE_CONFLICT', 'The list price was changed by someone else. Reload and try again.', {
        currentPriceCents: product.list_price_cents
      })
    }
    if (listPriceCents === product.list_price_cents) {
      throw invalidInput('The new price is the same as the current price', { field: 'listPriceCents' })
    }
    if (listPriceCents <= product.unit_cogs_cents) {
      throw new ApiError('PRICE_BELOW_COST', 'The list price must be above Cerbo\'s unit cost', {
        unitCogsCents: product.unit_cogs_cents
      })
    }

    await trx('products').where({ sku }).update({ list_price_cents: listPriceCents, updated_at: trx.fn.now() })
    const [row] = await trx<PriceChangeRow>('product_price_changes')
      .insert({
        sku,
        old_price_cents: product.list_price_cents,
        new_price_cents: listPriceCents,
        reason,
        actor_user_id: actor.id
      })
      .returning('*')
    return { product, row }
  })

  const counts = await activeScheduleCounts(db, [sku])
  const actorRow = await db('users').where({ id: actor.id }).first('display_name')
  return {
    sku,
    name: result.product.name,
    unitCogsCents: result.product.unit_cogs_cents,
    previousPriceCents: result.product.list_price_cents,
    listPriceCents,
    previousMarginBps: marginBpsFromPrice(result.product.unit_cogs_cents, result.product.list_price_cents),
    listMarginBps: marginBpsFromPrice(result.product.unit_cogs_cents, listPriceCents),
    activeScheduleCount: counts.get(sku) ?? 0,
    change: toChangeView({ ...result.row, actor_name: actorRow?.display_name ?? null })
  }
}

export interface ListPricePreview {
  sku: string
  name: string
  unitCogsCents: number
  currentPriceCents: number
  listPriceCents: number
  currentMarginBps: number
  listMarginBps: number
  /** True when the proposed price is at or below cost (the PATCH would be refused). */
  belowCost: boolean
  /** listPriceCents - currentPriceCents. Server-computed for display. */
  differenceCents: number
  activeScheduleCount: number
}

/**
 * GET /api/admin/products/:sku/list-price-preview?listPriceCents= - read-only review of a
 * proposed list price: margins before/after, whether it would be refused as below cost,
 * and how many active schedules would pick it up. Lets the admin UI show the impact
 * before saving without doing any money math in the browser.
 */
export async function previewListPrice(db: Knex, sku: string, raw: unknown): Promise<ListPricePreview> {
  const listPriceCents = requireInt(
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw,
    'listPriceCents',
    1,
    MAX_LIST_PRICE_CENTS
  )
  const product = await db<ProductRow>('products').where({ sku }).first()
  if (!product) throw notFound('No such product', { sku })
  const counts = await activeScheduleCounts(db, [sku])
  return {
    sku,
    name: product.name,
    unitCogsCents: product.unit_cogs_cents,
    currentPriceCents: product.list_price_cents,
    listPriceCents,
    currentMarginBps: marginBpsFromPrice(product.unit_cogs_cents, product.list_price_cents),
    listMarginBps: marginBpsFromPrice(product.unit_cogs_cents, listPriceCents),
    belowCost: listPriceCents <= product.unit_cogs_cents,
    differenceCents: listPriceCents - product.list_price_cents,
    activeScheduleCount: counts.get(sku) ?? 0
  }
}

/** GET /api/admin/products/:sku/price-history - newest first, last 50. */
export async function priceHistory(db: Knex, sku: string): Promise<PriceChangeView[]> {
  const product = await db('products').where({ sku }).first('sku')
  if (!product) throw notFound('No such product', { sku })
  const rows = await db<PriceChangeRow>('product_price_changes as c')
    .leftJoin('users as u', 'u.id', 'c.actor_user_id')
    .where('c.sku', sku)
    .orderBy([{ column: 'c.changed_at', order: 'desc' }, { column: 'c.id', order: 'desc' }])
    .limit(HISTORY_LIMIT)
    .select('c.*', 'u.display_name as actor_name')
  return rows.map(toChangeView)
}
