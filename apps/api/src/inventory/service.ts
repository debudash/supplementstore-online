// Inventory service (T3): the single shared stock pool (ADR-009).
//
// `available = on_hand - reserved` per SKU. Reservation and release happen under a
// row lock (SELECT ... FOR UPDATE) on `products` so two concurrent sends can never
// oversell (RT-05, AGENTS.md money rule 8). Every change writes an inventory_movements
// row with a reason from the schema enum (seed|restock|reserve|release|sale|
// refund_restock|adjustment).
import type { Knex } from 'knex'
import { priceFromMarkupCents, split, DEFAULT_FEE_BPS } from '@cerbo/money'
import { insufficientStock, notFound } from '../orders/errors'
import { requireInt, MARKUP_MIN, MARKUP_MAX } from '../orders/validation'

/** A quantity of one SKU to reserve or release. */
export interface SkuQty {
  sku: string
  qty: number
}

/**
 * Catalog row as the provider sees it (mirrors @cerbo/contracts OrderView's
 * ProductView; the contracts package exports only its index barrel, so API-side
 * types are declared locally and kept in sync with packages/contracts/src/orders.ts).
 */
export interface ProductView {
  sku: string
  name: string
  unitCogsCents: number
  available: number
  active: boolean
}

/** GET /api/products/:sku/price-preview response (ADR-028). */
export interface PricePreview {
  sku: string
  /** The per-unit markup previewed. */
  markupCents: number
  /** The unit price the order would get: COGS + markup grossed up for the fee. */
  unitPriceCents: number
  /** Quantity previewed (default 1) and the full split for that line (split()). */
  qty: number
  lineTotalCents: number
  lineCogsCents: number
  lineFeeCents: number
  lineMarginCents: number
}

interface ProductRow {
  sku: string
  name: string
  unit_cogs_cents: number
  on_hand_qty: number
  reserved_qty: number
  active: boolean
}

/** List the catalog with computed availability (GET /api/products). */
export async function listProducts(db: Knex): Promise<ProductView[]> {
  const rows = await db<ProductRow>('products').select('*').orderBy('sku')
  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    unitCogsCents: r.unit_cogs_cents,
    available: r.on_hand_qty - r.reserved_qty,
    active: r.active
  }))
}

/**
 * Preview the price a per-unit markup would produce for a SKU, using the same function
 * the add-line path uses (priceFromMarkupCents), so the preview is exactly what the
 * server will store. Read-only; the browser never computes a price (AGENTS.md money
 * rule 2).
 */
export async function previewPrice(
  db: Knex,
  sku: string,
  markupRaw: unknown,
  qtyRaw?: unknown
): Promise<PricePreview> {
  const asInt = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v)
  const markupCents = requireInt(asInt(markupRaw), 'markupCents', MARKUP_MIN, MARKUP_MAX)
  const qty = qtyRaw === undefined || qtyRaw === '' ? 1 : requireInt(asInt(qtyRaw), 'qty', 1, 100)
  const row = await getProduct(db, sku)
  const unitPriceCents = priceFromMarkupCents(row.unit_cogs_cents, markupCents, DEFAULT_FEE_BPS)

  // The same split() an order uses, for a one-line order of `qty` units.
  const line = split([{ position: 1, qty, unitPriceCents, unitCogsCents: row.unit_cogs_cents }], DEFAULT_FEE_BPS).lines[0]
  return {
    sku,
    markupCents,
    unitPriceCents,
    qty,
    lineTotalCents: line.total,
    lineCogsCents: line.cogs,
    lineFeeCents: line.fee,
    lineMarginCents: line.margin
  }
}

/** Fetch one product (no lock) for an add-to-cart availability check. 404 if absent. */
export async function getProduct(db: Knex, sku: string): Promise<ProductRow> {
  const row = await db<ProductRow>('products').where({ sku }).first()
  if (!row) throw notFound('No such product', { sku })
  return row
}

/** available = on_hand - reserved for the shared pool. */
export function availableOf(product: Pick<ProductRow, 'on_hand_qty' | 'reserved_qty'>): number {
  return product.on_hand_qty - product.reserved_qty
}

/**
 * Lock the given SKUs' product rows FOR UPDATE, in a deterministic order (by sku)
 * to avoid deadlocks between concurrent senders. Returns the locked rows keyed by sku.
 * Must be called inside a transaction.
 */
async function lockProducts(trx: Knex.Transaction, skus: string[]): Promise<Map<string, ProductRow>> {
  const unique = [...new Set(skus)].sort()
  const rows = await trx<ProductRow>('products').whereIn('sku', unique).orderBy('sku').forUpdate()
  const byId = new Map<string, ProductRow>()
  for (const r of rows) byId.set(r.sku, r)
  for (const sku of unique) {
    if (!byId.has(sku)) throw notFound('No such product', { sku })
  }
  return byId
}

/**
 * Reserve stock for an order's lines (send). Locks every product row, re-checks that
 * `available >= qty` for each line, then increments `reserved_qty` and records a
 * `reserve` movement. Throws INSUFFICIENT_STOCK (with available) and reserves nothing
 * if any line cannot be satisfied - the caller's transaction rolls back.
 */
export async function reserveLines(
  trx: Knex.Transaction,
  lines: SkuQty[],
  actorUserId: string | null,
  orderId: string
): Promise<void> {
  const locked = await lockProducts(trx, lines.map((l) => l.sku))
  // Validate first (all-or-nothing) so a later short line does not leave earlier
  // lines reserved within this same transaction.
  for (const line of lines) {
    const product = locked.get(line.sku) as ProductRow
    if (availableOf(product) < line.qty) {
      throw insufficientStock(availableOf(product))
    }
  }
  for (const line of lines) {
    await trx('products')
      .where({ sku: line.sku })
      .increment('reserved_qty', line.qty)
      .update({ updated_at: trx.fn.now() })
    await trx('inventory_movements').insert({
      sku: line.sku,
      delta_on_hand: 0,
      delta_reserved: line.qty,
      reason: 'reserve',
      order_id: orderId,
      actor_user_id: actorUserId
    })
  }
}

/**
 * Release a reservation (cancel of a sent order, or expiry). Decrements `reserved_qty`
 * and records a `release` movement per line. Locks the product rows so release never
 * races a concurrent reserve.
 */
export async function releaseLines(
  trx: Knex.Transaction,
  lines: SkuQty[],
  actorUserId: string | null,
  orderId: string
): Promise<void> {
  await lockProducts(trx, lines.map((l) => l.sku))
  for (const line of lines) {
    await trx('products')
      .where({ sku: line.sku })
      .decrement('reserved_qty', line.qty)
      .update({ updated_at: trx.fn.now() })
    await trx('inventory_movements').insert({
      sku: line.sku,
      delta_on_hand: 0,
      delta_reserved: -line.qty,
      reason: 'release',
      order_id: orderId,
      actor_user_id: actorUserId
    })
  }
}
