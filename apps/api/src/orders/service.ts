// Order lifecycle service (T3): draft, lines, quote, send (snapshot + reserve),
// cancel. FR-1..FR-4. All split math routes through @cerbo/money (AGENTS.md money
// rule 2); the server computes every amount from DB snapshots and ignores any total
// a client might send (money rule 9). Stock changes take a products row lock and
// write inventory_movements (money rule 8).
import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { split, priceFromMarginBps, type OrderSplit, type SplitLineInput } from '@cerbo/money'
import type { Actor } from '../auth/types'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { invalidInput, notFound, orderNotEditable, ApiError } from './errors'
import { releaseLines, reserveLines, availableOf } from '../inventory/service'
import {
  requireString,
  requireInt,
  optionalInt,
  QTY_MIN,
  QTY_MAX,
  PRICE_MIN,
  PRICE_MAX,
  MARGIN_BPS_MIN,
  MARGIN_BPS_MAX
} from './validation'

/** Reservation lifetime after send (FR-4 AC3, ADR-011). */
export const RESERVATION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

interface OrderRow {
  id: string
  provider_id: string
  practice_id: string
  patient_id: string
  kind: string
  status: string
  fee_bps: number
  subtotal_cents: number | null
  cogs_cents: number | null
  fee_cents: number | null
  margin_cents: number | null
  pay_token: string | null
  reservation_expires_at: Date | null
  sent_at: Date | null
  cancelled_at: Date | null
  expired_at: Date | null
  created_at: Date
  updated_at: Date
}

interface LineRow {
  id: string
  order_id: string
  position: number
  sku: string
  qty: number
  unit_price_cents: number
  unit_cogs_cents: number
  line_total_cents: number | null
  line_cogs_cents: number | null
  line_fee_cents: number | null
  line_margin_cents: number | null
}

interface ProductRow {
  sku: string
  name: string
  unit_cogs_cents: number
  on_hand_qty: number
  reserved_qty: number
  active: boolean
}

// ---- Views (mirror packages/contracts/src/orders.ts) ----

export interface OrderLineView {
  id: string
  position: number
  sku: string
  name: string
  qty: number
  unitPriceCents: number
  unitCogsCents: number
  lineTotalCents: number
  lineCogsCents: number
  lineFeeCents: number
  lineMarginCents: number
}

export interface OrderView {
  id: string
  status: string
  providerId: string
  practiceId: string
  patientId: string
  feeBps: number
  totals: {
    feeBps: number
    subtotalCents: number
    cogsCents: number
    feeCents: number
    marginCents: number
  } | null
  lines: OrderLineView[]
  payToken: string | null
  reservationExpiresAt: string | null
  sentAt: string | null
  createdAt: string
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

// ---- Ownership ----

/**
 * Load an order the actor is allowed to see, or throw 404. A provider only owns
 * orders on their own provider_id; anything else returns NOT_FOUND so existence is
 * never leaked (AGENTS.md section 7, RT-01).
 */
async function loadOwnedOrder(db: Knex, actor: Actor, orderId: string): Promise<OrderRow> {
  const order = await db<OrderRow>('orders').where({ id: orderId }).first()
  if (!order || order.provider_id !== actor.providerId) {
    throw notFound('No such order', { orderId })
  }
  return order
}

async function getLines(db: Knex, orderId: string): Promise<LineRow[]> {
  return db<LineRow>('order_lines').where({ order_id: orderId }).orderBy('position')
}

async function productsBySku(db: Knex, skus: string[]): Promise<Map<string, ProductRow>> {
  const rows = await db<ProductRow>('products').whereIn('sku', [...new Set(skus)])
  const map = new Map<string, ProductRow>()
  for (const r of rows) map.set(r.sku, r)
  return map
}

// ---- Split helpers ----

/**
 * Compute the live split for a draft from the stored canonical prices and the CURRENT
 * catalog COGS (snapshot only happens at send, ADR-006). Throws MARGIN_NEGATIVE if any
 * line's margin after its allocated fee is < 0 (FR-2 AC3). Empty line sets are the
 * caller's responsibility.
 */
function liveSplit(order: OrderRow, lines: LineRow[], products: Map<string, ProductRow>): OrderSplit {
  const inputs: SplitLineInput[] = lines.map((l) => {
    const product = products.get(l.sku)
    if (!product) throw notFound('No such product', { sku: l.sku })
    return {
      position: l.position,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      unitCogsCents: product.unit_cogs_cents
    }
  })
  return split(inputs, order.fee_bps)
}

function viewFromRows(order: OrderRow, lines: LineRow[], names: Map<string, string>): OrderView {
  const totals =
    order.subtotal_cents !== null &&
    order.cogs_cents !== null &&
    order.fee_cents !== null &&
    order.margin_cents !== null
      ? {
          feeBps: order.fee_bps,
          subtotalCents: order.subtotal_cents,
          cogsCents: order.cogs_cents,
          feeCents: order.fee_cents,
          marginCents: order.margin_cents
        }
      : null
  return {
    id: order.id,
    status: order.status,
    providerId: order.provider_id,
    practiceId: order.practice_id,
    patientId: order.patient_id,
    feeBps: order.fee_bps,
    totals,
    lines: lines.map((l) => ({
      id: l.id,
      position: l.position,
      sku: l.sku,
      name: names.get(l.sku) ?? l.sku,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      unitCogsCents: l.unit_cogs_cents,
      lineTotalCents: l.line_total_cents ?? 0,
      lineCogsCents: l.line_cogs_cents ?? 0,
      lineFeeCents: l.line_fee_cents ?? 0,
      lineMarginCents: l.line_margin_cents ?? 0
    })),
    payToken: order.pay_token,
    reservationExpiresAt: iso(order.reservation_expires_at),
    sentAt: iso(order.sent_at),
    createdAt: new Date(order.created_at).toISOString()
  }
}

/** Build an OrderView after a mutation, pulling fresh lines + product names. */
async function buildView(db: Knex, order: OrderRow): Promise<OrderView> {
  const lines = await getLines(db, order.id)
  const products = await productsBySku(db, lines.map((l) => l.sku))
  const names = new Map([...products].map(([sku, p]) => [sku, p.name]))
  return viewFromRows(order, lines, names)
}

// ---- Commands ----

/** POST /api/orders - open a draft for one of the provider's own patients (FR-1 AC1). */
export async function createDraft(db: Knex, actor: Actor, body: unknown): Promise<OrderView> {
  const b = (body ?? {}) as Record<string, unknown>
  const patientId = requireString(b.patientId, 'patientId')

  // The patient must belong to the provider's practice, else 404 (no existence leak).
  const patient = await db('patients').where({ id: patientId }).first()
  if (!patient || patient.practice_id !== actor.practiceId) {
    throw notFound('No such patient', { patientId })
  }

  const order = await db.transaction(async (trx) => {
    const [row] = await trx<OrderRow>('orders')
      .insert({
        provider_id: actor.providerId as string,
        practice_id: actor.practiceId as string,
        patient_id: patientId,
        kind: 'one_off',
        status: 'draft'
      })
      .returning('*')
    await trx('order_events').insert({
      order_id: row.id,
      from_status: null,
      to_status: 'draft',
      actor_user_id: actor.id,
      note: 'draft created'
    })
    return row
  })
  return buildView(db, order)
}

/** Resolve the canonical unit price from either an explicit price or a margin %. */
function resolveUnitPrice(
  unitPriceCents: number | undefined,
  marginBps: number | undefined,
  unitCogsCents: number
): number {
  if (unitPriceCents !== undefined) return unitPriceCents
  if (marginBps !== undefined) return priceFromMarginBps(unitCogsCents, marginBps)
  throw invalidInput('either unitPriceCents or marginBps is required', {
    field: 'unitPriceCents|marginBps'
  })
}

/** POST /api/orders/:id/lines - add/merge a SKU on a draft (FR-1, FR-2, FR-3). */
export async function addLine(
  db: Knex,
  actor: Actor,
  orderId: string,
  body: unknown
): Promise<OrderView> {
  const order = await loadOwnedOrder(db, actor, orderId)
  if (order.status !== 'draft') throw orderNotEditable(order.status)

  const b = (body ?? {}) as Record<string, unknown>
  const sku = requireString(b.sku, 'sku')
  const qty = requireInt(b.qty, 'qty', QTY_MIN, QTY_MAX)
  const unitPriceCents = optionalInt(b.unitPriceCents, 'unitPriceCents', PRICE_MIN, PRICE_MAX)
  const marginBps = optionalInt(b.marginBps, 'marginBps', MARGIN_BPS_MIN, MARGIN_BPS_MAX)

  const updated = await db.transaction(async (trx) => {
    const product = await trx<ProductRow>('products').where({ sku }).first()
    if (!product) throw notFound('No such product', { sku })

    const unitPrice = resolveUnitPrice(unitPriceCents, marginBps, product.unit_cogs_cents)

    // Merge into an existing line for this SKU (FR-1 AC2): quantities sum.
    const existing = await trx<LineRow>('order_lines').where({ order_id: orderId, sku }).first()
    const mergedQty = (existing?.qty ?? 0) + qty
    if (mergedQty > QTY_MAX) {
      throw invalidInput(`merged quantity ${mergedQty} exceeds ${QTY_MAX}`, { field: 'qty', mergedQty })
    }

    // Add-to-cart stock gate (FR-3 AC1): available must cover the cart total for this SKU.
    // Because adding SUMS with what is already on the order (FR-1 AC2), the remaining
    // headroom the provider can still add is `available - already on the order`, clamped
    // at 0. We surface it as `remaining` so the UI can show the honest "how many more"
    // number without doing stock arithmetic in the browser (the server owns stock truth).
    const available = availableOf(product)
    if (available < mergedQty) {
      const remaining = Math.max(0, available - (existing?.qty ?? 0))
      throw new ApiError('INSUFFICIENT_STOCK', 'Not enough stock to satisfy this quantity', {
        available,
        remaining
      })
    }

    if (existing) {
      await trx('order_lines')
        .where({ id: existing.id })
        .update({ qty: mergedQty, unit_price_cents: unitPrice, unit_cogs_cents: product.unit_cogs_cents })
    } else {
      const [{ max }] = await trx('order_lines')
        .where({ order_id: orderId })
        .max<{ max: number | null }[]>('position as max')
      const nextPosition = (max ?? 0) + 1
      await trx('order_lines').insert({
        order_id: orderId,
        position: nextPosition,
        sku,
        qty,
        unit_price_cents: unitPrice,
        unit_cogs_cents: product.unit_cogs_cents
      })
    }

    // Re-validate the whole cart's margin after this change (FR-2 AC3). A negative
    // line margin throws MARGIN_NEGATIVE and rolls the insert/update back.
    const lines = await trx<LineRow>('order_lines').where({ order_id: orderId }).orderBy('position')
    const products = await productsMapTrx(trx, lines.map((l) => l.sku))
    liveSplit(order, lines, products)
    return order
  })
  return buildView(db, updated)
}

/** PATCH /api/orders/:id/lines/:lineId - edit qty and/or price on a draft (FR-1 AC4). */
export async function updateLine(
  db: Knex,
  actor: Actor,
  orderId: string,
  lineId: string,
  body: unknown
): Promise<OrderView> {
  const order = await loadOwnedOrder(db, actor, orderId)
  if (order.status !== 'draft') throw orderNotEditable(order.status)

  const b = (body ?? {}) as Record<string, unknown>
  const qty = optionalInt(b.qty, 'qty', QTY_MIN, QTY_MAX)
  const unitPriceCents = optionalInt(b.unitPriceCents, 'unitPriceCents', PRICE_MIN, PRICE_MAX)
  const marginBps = optionalInt(b.marginBps, 'marginBps', MARGIN_BPS_MIN, MARGIN_BPS_MAX)

  await db.transaction(async (trx) => {
    const line = await trx<LineRow>('order_lines').where({ id: lineId, order_id: orderId }).first()
    if (!line) throw notFound('No such line', { lineId })
    const product = await trx<ProductRow>('products').where({ sku: line.sku }).first()
    if (!product) throw notFound('No such product', { sku: line.sku })

    const newQty = qty ?? line.qty
    let newPrice = line.unit_price_cents
    if (unitPriceCents !== undefined) newPrice = unitPriceCents
    else if (marginBps !== undefined) newPrice = priceFromMarginBps(product.unit_cogs_cents, marginBps)

    // Stock gate for the new quantity (FR-3 AC1).
    const available = availableOf(product)
    if (available < newQty) {
      throw new ApiError('INSUFFICIENT_STOCK', 'Not enough stock to satisfy this quantity', {
        available
      })
    }

    await trx('order_lines')
      .where({ id: lineId })
      .update({ qty: newQty, unit_price_cents: newPrice, unit_cogs_cents: product.unit_cogs_cents })

    const lines = await trx<LineRow>('order_lines').where({ order_id: orderId }).orderBy('position')
    const products = await productsMapTrx(trx, lines.map((l) => l.sku))
    liveSplit(order, lines, products)
  })
  return buildView(db, order)
}

/** DELETE /api/orders/:id/lines/:lineId - remove a line from a draft (FR-1 AC4). */
export async function deleteLine(
  db: Knex,
  actor: Actor,
  orderId: string,
  lineId: string
): Promise<OrderView> {
  const order = await loadOwnedOrder(db, actor, orderId)
  if (order.status !== 'draft') throw orderNotEditable(order.status)

  await db.transaction(async (trx) => {
    const deleted = await trx('order_lines').where({ id: lineId, order_id: orderId }).del()
    if (deleted === 0) throw notFound('No such line', { lineId })

    // Removing a line changes fee allocation; re-validate any remaining lines.
    const lines = await trx<LineRow>('order_lines').where({ order_id: orderId }).orderBy('position')
    if (lines.length > 0) {
      const products = await productsMapTrx(trx, lines.map((l) => l.sku))
      liveSplit(order, lines, products)
    }
  })
  return buildView(db, order)
}

/** GET /api/orders/:id/quote - live split preview (FR-2 AC2). */
export async function getQuote(db: Knex, actor: Actor, orderId: string): Promise<{
  orderId: string
  status: string
  totals: OrderView['totals']
  lines: OrderLineView[]
}> {
  const order = await loadOwnedOrder(db, actor, orderId)
  const lines = await getLines(db, orderId)
  const products = await productsBySku(db, lines.map((l) => l.sku))
  const names = new Map([...products].map(([sku, p]) => [sku, p.name]))

  if (lines.length === 0) {
    return {
      orderId,
      status: order.status,
      totals: { feeBps: order.fee_bps, subtotalCents: 0, cogsCents: 0, feeCents: 0, marginCents: 0 },
      lines: []
    }
  }

  // Drafts preview live catalog COGS; sent+ orders report their persisted snapshot.
  if (order.status === 'draft') {
    const result = liveSplit(order, lines, products)
    const bySplitPosition = new Map(result.lines.map((l) => [l.position, l]))
    return {
      orderId,
      status: order.status,
      totals: {
        feeBps: result.feeBps,
        subtotalCents: result.subtotal,
        cogsCents: result.cogs,
        feeCents: result.fee,
        marginCents: result.margin
      },
      lines: lines.map((l) => {
        const s = bySplitPosition.get(l.position)
        return {
          id: l.id,
          position: l.position,
          sku: l.sku,
          name: names.get(l.sku) ?? l.sku,
          qty: l.qty,
          unitPriceCents: l.unit_price_cents,
          unitCogsCents: products.get(l.sku)?.unit_cogs_cents ?? l.unit_cogs_cents,
          lineTotalCents: s?.total ?? 0,
          lineCogsCents: s?.cogs ?? 0,
          lineFeeCents: s?.fee ?? 0,
          lineMarginCents: s?.margin ?? 0
        }
      })
    }
  }

  const view = viewFromRows(order, lines, names)
  return { orderId, status: order.status, totals: view.totals, lines: view.lines }
}

/**
 * POST /api/orders/:id/send - snapshot, compute the split, reserve stock, and move the
 * order to `sent` (FR-4). Everything happens in one transaction with a products row
 * lock: the split is computed from the just-locked snapshot COGS, stock is re-checked,
 * and nothing is reserved if any check fails (FR-4 AC2).
 */
export async function sendOrder(
  db: Knex,
  actor: Actor,
  orderId: string,
  seams: Seams = createSeams()
): Promise<{ order: OrderView; payUrl: string }> {
  const order = await loadOwnedOrder(db, actor, orderId)
  if (order.status !== 'draft') throw orderNotEditable(order.status)

  const existingLines = await getLines(db, orderId)
  if (existingLines.length === 0) throw invalidInput('cannot send an order with no lines', { orderId })

  const now = seams.clock.now()
  const expiresAt = new Date(now.getTime() + RESERVATION_DAYS * DAY_MS)
  const payToken = randomBytes(24).toString('base64url')

  const sent = await db.transaction(async (trx) => {
    // Lock the product rows (ordered) and snapshot their COGS now (ADR-006).
    const skus = [...new Set(existingLines.map((l) => l.sku))].sort()
    const locked = await trx<ProductRow>('products').whereIn('sku', skus).orderBy('sku').forUpdate()
    const bySku = new Map(locked.map((p) => [p.sku, p]))

    const inputs: SplitLineInput[] = existingLines.map((l) => {
      const product = bySku.get(l.sku)
      if (!product) throw notFound('No such product', { sku: l.sku })
      return {
        position: l.position,
        qty: l.qty,
        unitPriceCents: l.unit_price_cents,
        unitCogsCents: product.unit_cogs_cents
      }
    })

    // Compute the split from the snapshot (throws MARGIN_NEGATIVE -> rollback, nothing reserved).
    const result = split(inputs, order.fee_bps)
    const bySplitPosition = new Map(result.lines.map((l) => [l.position, l]))

    // Re-check stock and reserve under the same lock (throws INSUFFICIENT_STOCK -> rollback).
    await reserveLines(
      trx,
      existingLines.map((l) => ({ sku: l.sku, qty: l.qty })),
      actor.id,
      orderId
    )

    // Persist per-line snapshot + computed split.
    for (const l of existingLines) {
      const s = bySplitPosition.get(l.position)
      if (!s) throw invalidInput('internal: missing split for line', { position: l.position })
      await trx('order_lines').where({ id: l.id }).update({
        unit_cogs_cents: bySku.get(l.sku)?.unit_cogs_cents,
        line_total_cents: s.total,
        line_cogs_cents: s.cogs,
        line_fee_cents: s.fee,
        line_margin_cents: s.margin
      })
    }

    const [row] = await trx<OrderRow>('orders')
      .where({ id: orderId })
      .update({
        status: 'sent',
        subtotal_cents: result.subtotal,
        cogs_cents: result.cogs,
        fee_cents: result.fee,
        margin_cents: result.margin,
        sent_at: now,
        reservation_expires_at: expiresAt,
        pay_token: payToken,
        updated_at: now
      })
      .returning('*')

    await trx('order_events').insert({
      order_id: orderId,
      from_status: 'draft',
      to_status: 'sent',
      actor_user_id: actor.id,
      note: 'sent to patient'
    })
    return row
  })

  // Notify the patient of their pay link (FR-4 AC4). The stub logs; the UI shows a
  // copyable link. Done after commit so a notifier hiccup never rolls back the send.
  const patient = await db('patients').where({ id: sent.patient_id }).first()
  const payUrl = `/pay/${payToken}`
  await seams.notifier.sendPayLink(
    { id: sent.patient_id, name: patient?.name, email: patient?.email ?? null },
    payUrl
  )

  const view = await buildView(db, sent)
  return { order: view, payUrl }
}

/** POST /api/orders/:id/cancel - cancel a draft or sent order; sent releases stock (FR-4 AC5). */
export async function cancelOrder(db: Knex, actor: Actor, orderId: string): Promise<OrderView> {
  const order = await loadOwnedOrder(db, actor, orderId)
  if (order.status !== 'draft' && order.status !== 'sent') {
    throw orderNotEditable(order.status)
  }

  const now = new Date()
  const cancelled = await db.transaction(async (trx) => {
    if (order.status === 'sent') {
      const lines = await trx<LineRow>('order_lines').where({ order_id: orderId }).orderBy('position')
      await releaseLines(
        trx,
        lines.map((l) => ({ sku: l.sku, qty: l.qty })),
        actor.id,
        orderId
      )
    }
    const [row] = await trx<OrderRow>('orders')
      .where({ id: orderId })
      .update({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .returning('*')
    await trx('order_events').insert({
      order_id: orderId,
      from_status: order.status,
      to_status: 'cancelled',
      actor_user_id: actor.id,
      note: 'cancelled by provider'
    })
    return row
  })
  return buildView(db, cancelled)
}

/** GET /api/orders?status=&from=&to= - the provider's own orders (FR). */
export async function listOrders(
  db: Knex,
  actor: Actor,
  filters: { status?: string; from?: string; to?: string }
): Promise<Array<{
  id: string
  status: string
  patientId: string
  subtotalCents: number | null
  createdAt: string
  sentAt: string | null
  payToken: string | null
  payPath: string | null
}>> {
  let q = db<OrderRow>('orders')
    .where('provider_id', actor.providerId as string)
    .orderBy('created_at', 'desc')
  if (filters.status) q = q.andWhere({ status: filters.status })
  if (filters.from) q = q.andWhere('created_at', '>=', filters.from)
  if (filters.to) q = q.andWhere('created_at', '<=', filters.to)
  const rows = await q
  // Surface the pay link so the provider can recover it after send (the token is stored
  // on the order but was previously only returned by create/add/send). This is the
  // provider's OWN order (the query is scoped to actor.providerId above), so returning
  // their token leaks nothing they are not already entitled to. Null for drafts.
  return rows.map((o) => ({
    id: o.id,
    status: o.status,
    patientId: o.patient_id,
    subtotalCents: o.subtotal_cents,
    createdAt: new Date(o.created_at).toISOString(),
    sentAt: iso(o.sent_at),
    payToken: o.pay_token,
    payPath: o.pay_token ? `/pay/${o.pay_token}` : null
  }))
}

/** Product map within a transaction (for in-flight margin re-checks). */
async function productsMapTrx(trx: Knex.Transaction, skus: string[]): Promise<Map<string, ProductRow>> {
  const rows = await trx<ProductRow>('products').whereIn('sku', [...new Set(skus)])
  const map = new Map<string, ProductRow>()
  for (const r of rows) map.set(r.sku, r)
  return map
}
