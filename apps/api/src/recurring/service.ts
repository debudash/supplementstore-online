// Recurring schedules + cycles (T9) - FR-12, ADR-017 as amended by ADR-024.
//
// A schedule generates one CHILD ORDER per cycle. The provider sets product + quantity +
// a per-unit dollar markup + interval (ADR-028). The patient authorizes ONCE via the token
// route. Each cycle reads the CURRENT unit_cogs_cents and prices each line as COGS + the
// schedule's markup grossed up for the fee (ADR-028, superseding the price clause of
// ADR-024), so a cost rise passes through to the patient and the provider keeps the markup.
// It then runs the same checks a normal order runs and either PAYS (via T4's posting path)
// or goes `on_hold` with a `hold_reason`.
//
// Money rules honoured here:
//  - rule 2: ALL split math goes through @cerbo/money (split(), priceFromMarkupCents());
//    nothing is recomputed here. COGS is read fresh from the catalog each cycle.
//  - rule 6/7/8: the cycle PAYMENT journal is posted by T4's postPaymentJournal (NO
//    duplicate posting code), inside ONE transaction that also changes order status and
//    inventory, under a row lock.
//  - rule 9: the charge amount is the server-computed subtotal, never a client value.
//  - rule 10: amounts are validated as safe integers before use.
//
// CONCURRENCY (RT-13): one child order per cycle is guaranteed by a SELECT ... FOR UPDATE
// row lock on the schedule plus a next_run_at due-gate - the same serialisation the pay
// flow (RT-04) uses - NOT by a DB unique constraint (the approved data model has none on
// (schedule_id, cycle_number); see the MR description).
import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { split, priceFromMarkupCents, type SplitLineInput } from '@cerbo/money'
import { MoneyError } from '@cerbo/money'
import type { Actor } from '../auth/types'
import type { Seams } from '../seams/types'
import { createSeams } from '../seams'
import { assertSafeInteger } from '../db/types'
import { postPaymentJournal } from '../ledger'
import { availableOf } from '../inventory/service'
import {
  requireString,
  requireInt,
  optionalInt,
  QTY_MIN,
  QTY_MAX,
  MARKUP_MIN,
  MARKUP_MAX
} from '../orders/validation'
import { notFound, invalidInput, notActionable } from './errors'
import type {
  HoldReason,
  RunCycleResult,
  ScheduleAuthorizeResult,
  ScheduleAuthorizeView,
  ScheduleCycleView,
  ScheduleView
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const FEE_BPS = 75

// ---- Row shapes ----

interface ScheduleRow {
  id: string
  provider_id: string
  practice_id: string
  patient_id: string
  interval_days: number
  next_run_at: Date | null
  status: string
  authorized_at: Date | null
  payment_method_token: string | null
  pay_token: string | null
  created_at: Date
}

interface ScheduleLineRow {
  id: string
  schedule_id: string
  position: number
  sku: string
  qty: number
  unit_price_cents: number
  unit_markup_cents: number
}

interface CycleOrderRow {
  id: string
  schedule_id: string | null
  cycle_number: number | null
  status: string
  hold_reason: string | null
  subtotal_cents: number | null
  is_synthetic: boolean
  provider_id: string
  practice_id: string
  patient_id: string
  created_at: Date
}

interface OrderLineRow {
  id: string
  order_id: string
  sku: string
  qty: number
  unit_price_cents: number
  unit_cogs_cents: number
  unit_markup_cents: number | null
}

interface ProductRow {
  sku: string
  name: string
  unit_cogs_cents: number
  on_hand_qty: number
  reserved_qty: number
  active: boolean
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

/** A cycle's unit price: current COGS + the provider's markup, grossed up for the fee. */
const cyclePrice = (unitCogsCents: number, markupCents: number): number =>
  priceFromMarkupCents(unitCogsCents, markupCents, FEE_BPS)

// ---- Ownership ----

async function loadOwnedSchedule(db: Knex, actor: Actor, id: string): Promise<ScheduleRow> {
  const row = await db<ScheduleRow>('recurring_schedules').where({ id }).first()
  if (!row || row.provider_id !== actor.providerId) {
    throw notFound('No such schedule', { scheduleId: id })
  }
  return row
}

async function lockProducts(trx: Knex.Transaction, skus: string[]): Promise<Map<string, ProductRow>> {
  const unique = [...new Set(skus)].sort()
  const rows = await trx<ProductRow>('products').whereIn('sku', unique).orderBy('sku').forUpdate()
  const bySku = new Map<string, ProductRow>()
  for (const r of rows) bySku.set(r.sku, r)
  for (const sku of unique) if (!bySku.has(sku)) throw notFound('No such product', { sku })
  return bySku
}

// ---- Provider: create ----

/** POST /api/schedules - open a recurring schedule for one of the provider's patients. */
export async function createSchedule(db: Knex, actor: Actor, body: unknown): Promise<ScheduleView> {
  const b = (body ?? {}) as Record<string, unknown>
  const patientId = requireString(b.patientId, 'patientId')
  const intervalDays = optionalInt(b.intervalDays, 'intervalDays', 7, 90) ?? 30
  const rawLines = Array.isArray(b.lines) ? (b.lines as Array<Record<string, unknown>>) : null
  if (!rawLines || rawLines.length === 0) {
    throw invalidInput('at least one line is required', { field: 'lines' })
  }

  const patient = await db('patients').where({ id: patientId }).first()
  if (!patient || patient.practice_id !== actor.practiceId) {
    throw notFound('No such patient', { patientId })
  }

  const scheduleId = await db.transaction(async (trx) => {
    const payToken = randomBytes(24).toString('base64url')
    const now = new Date()
    const [schedule] = await trx<ScheduleRow>('recurring_schedules')
      .insert({
        provider_id: actor.providerId as string,
        practice_id: actor.practiceId as string,
        patient_id: patientId,
        interval_days: intervalDays,
        // Due immediately so the demo "Run cycle now" and the run-due job can fire the
        // first cycle without waiting for a real scheduler (FR-12 AC6).
        next_run_at: now,
        status: 'active',
        pay_token: payToken
      })
      .returning('*')

    // Each line carries the provider's per-unit markup (ADR-028). The price is DERIVED at
    // each cycle from the CURRENT COGS + that markup. We store today's derived price on the
    // schedule line as an INDICATIVE snapshot (the schema requires unit_price_cents > 0),
    // but the cycle re-derives it fresh and never reads this value for money.
    const seenSku = new Set<string>()
    const resolved: Array<{ position: number; sku: string; qty: number; markupCents: number; unitPriceCents: number }> = []
    let position = 1
    for (const raw of rawLines) {
      const sku = requireString(raw.sku, 'sku')
      if (seenSku.has(sku)) throw invalidInput('duplicate sku in schedule', { field: 'lines', sku })
      seenSku.add(sku)
      const qty = requireInt(raw.qty, 'qty', QTY_MIN, QTY_MAX)
      const markupCents = requireInt(raw.markupCents, 'markupCents', MARKUP_MIN, MARKUP_MAX)

      const product = await trx<ProductRow>('products').where({ sku }).first()
      if (!product) throw notFound('No such product', { sku })

      resolved.push({
        position: position++,
        sku,
        qty,
        markupCents,
        unitPriceCents: cyclePrice(product.unit_cogs_cents, markupCents)
      })
    }

    await trx('schedule_lines').insert(
      resolved.map((l) => ({
        schedule_id: schedule.id,
        position: l.position,
        sku: l.sku,
        qty: l.qty,
        unit_price_cents: l.unitPriceCents,
        unit_markup_cents: l.markupCents
      }))
    )
    return schedule.id
  })

  return getScheduleView(db, scheduleId)
}

// ---- Provider: list / lifecycle ----

export async function listSchedules(db: Knex, actor: Actor): Promise<ScheduleView[]> {
  const rows = await db<ScheduleRow>('recurring_schedules')
    .where('provider_id', actor.providerId as string)
    .orderBy('created_at', 'desc')
  return Promise.all(rows.map((r) => buildScheduleView(db, r)))
}

export async function pauseSchedule(db: Knex, actor: Actor, id: string): Promise<ScheduleView> {
  const s = await loadOwnedSchedule(db, actor, id)
  if (s.status === 'cancelled') throw notActionable('A cancelled schedule cannot be paused', { status: s.status })
  if (s.status === 'active') await db('recurring_schedules').where({ id }).update({ status: 'paused' })
  return getScheduleView(db, id)
}

export async function resumeSchedule(db: Knex, actor: Actor, id: string): Promise<ScheduleView> {
  const s = await loadOwnedSchedule(db, actor, id)
  if (s.status === 'cancelled') throw notActionable('A cancelled schedule cannot be resumed', { status: s.status })
  if (s.status === 'paused') await db('recurring_schedules').where({ id }).update({ status: 'active' })
  return getScheduleView(db, id)
}

export async function cancelSchedule(db: Knex, actor: Actor, id: string): Promise<ScheduleView> {
  const s = await loadOwnedSchedule(db, actor, id)
  if (s.status !== 'cancelled') await db('recurring_schedules').where({ id }).update({ status: 'cancelled' })
  return getScheduleView(db, id)
}

/** POST /api/schedules/:id/run - provider "Run cycle now" (FR-12 AC6). */
export async function runScheduleById(
  db: Knex,
  actor: Actor,
  id: string,
  seams: Seams = createSeams()
): Promise<RunCycleResult> {
  await loadOwnedSchedule(db, actor, id) // ownership (404 if not the provider's)
  return runOneSchedule(db, id, seams.clock.now(), seams)
}

// ---- Cycle engine (shared by run-now and the run-due job) ----

/**
 * Run (or retry) exactly one cycle for a schedule, in ONE transaction with the schedule
 * row locked FOR UPDATE. Returns the cycle that was touched.
 *
 *  - Not active -> no-op.
 *  - Latest cycle is on_hold -> RETRY it (re-snapshot COGS, re-check, maybe pay).
 *  - Otherwise, if due -> CREATE the next cycle and settle it; advance next_run_at.
 *  - Otherwise -> no-op (this is what makes a double-trigger idempotent: RT-13).
 */
export async function runOneSchedule(
  db: Knex,
  scheduleId: string,
  now: Date,
  seams: Seams
): Promise<RunCycleResult> {
  return db.transaction(async (trx) => {
    const schedule = await trx<ScheduleRow>('recurring_schedules').where({ id: scheduleId }).forUpdate().first()
    if (!schedule) throw notFound('No such schedule', { scheduleId })

    if (schedule.status !== 'active') {
      return { scheduleId, cycle: null, created: false, note: `schedule is ${schedule.status}` }
    }

    const latest = await trx<CycleOrderRow>('orders')
      .where({ schedule_id: scheduleId })
      .orderBy('cycle_number', 'desc')
      .first()

    // Retry an on_hold cycle in place (no new order) - "retry after the cause is fixed".
    if (latest && latest.status === 'on_hold') {
      const settled = await settleCycle(trx, schedule, latest, now, seams)
      return { scheduleId, cycle: toCycleView(settled), created: false, note: `retry: ${settled.status}` }
    }

    const due = !schedule.next_run_at || new Date(schedule.next_run_at).getTime() <= now.getTime()
    if (!due) {
      return { scheduleId, cycle: latest ? toCycleView(latest) : null, created: false, note: 'not due' }
    }

    const cycleNumber = (latest?.cycle_number ?? 0) + 1
    const order = await createCycleOrder(trx, schedule, cycleNumber)
    const settled = await settleCycle(trx, schedule, order, now, seams)

    // The period is now claimed by this cycle order (paid or on_hold); advance the clock
    // so a concurrent/second trigger for the same period is a no-op (RT-13).
    await trx('recurring_schedules')
      .where({ id: scheduleId })
      .update({ next_run_at: new Date(now.getTime() + schedule.interval_days * DAY_MS) })

    return { scheduleId, cycle: toCycleView(settled), created: true, note: settled.status }
  })
}

/** Insert the child order shell (on_hold, no totals yet) plus its lines from the schedule. */
async function createCycleOrder(
  trx: Knex.Transaction,
  schedule: ScheduleRow,
  cycleNumber: number
): Promise<CycleOrderRow> {
  const [orderRaw] = await trx('orders')
    .insert({
      provider_id: schedule.provider_id,
      practice_id: schedule.practice_id,
      patient_id: schedule.patient_id,
      kind: 'recurring_cycle',
      schedule_id: schedule.id,
      cycle_number: cycleNumber,
      status: 'on_hold',
      fee_bps: FEE_BPS
    })
    .returning('*')
  const order = orderRaw as CycleOrderRow

  const scheduleLines = await trx<ScheduleLineRow>('schedule_lines')
    .where({ schedule_id: schedule.id })
    .orderBy('position')

  // Seed the cycle's lines with the schedule's markup and a price from the CURRENT COGS
  // (ADR-028). settleCycle re-reads COGS under the products lock and re-derives the price,
  // so these are just the initial fresh snapshot (kept > 0 to satisfy the column checks).
  const products = await trx<ProductRow>('products')
    .whereIn('sku', scheduleLines.map((l) => l.sku))
  const bySku = new Map(products.map((p) => [p.sku, p]))

  await trx('order_lines').insert(
    scheduleLines.map((l) => ({
      order_id: order.id,
      position: l.position,
      sku: l.sku,
      qty: l.qty,
      unit_price_cents: cyclePrice(bySku.get(l.sku)?.unit_cogs_cents ?? 1, l.unit_markup_cents),
      unit_cogs_cents: bySku.get(l.sku)?.unit_cogs_cents ?? 1,
      unit_markup_cents: l.unit_markup_cents
    }))
  )
  await trx('order_events').insert({
    order_id: order.id,
    from_status: null,
    to_status: 'on_hold',
    actor_user_id: null,
    note: `recurring cycle ${cycleNumber} created`
  })
  return order
}

/**
 * Settle one cycle order: fresh-COGS split, stock + auth checks, charge, and (on success)
 * the FULL money record via T4's posting path. Any failure parks the order `on_hold` with
 * a `hold_reason` and leaves no payment, no journal, and no stock change (ADR-017).
 */
async function settleCycle(
  trx: Knex.Transaction,
  schedule: ScheduleRow,
  order: CycleOrderRow,
  now: Date,
  seams: Seams
): Promise<CycleOrderRow> {
  const lines = await trx<OrderLineRow>('order_lines').where({ order_id: order.id }).orderBy('position')
  const products = await lockProducts(trx, lines.map((l) => l.sku))

  // 1. Authorisation (patient authorised the schedule once). EVAL-11c.
  if (!schedule.authorized_at) {
    return hold(trx, order, now, 'NOT_AUTHORIZED')
  }

  // 2. Split with FRESH catalog COGS and a price derived from it + the line's markup
  //    (ADR-028): a cost rise passes through to the patient and the provider keeps the
  //    markup (EVAL-11d). A markup price always covers the fee, so MARGIN_NEGATIVE can only
  //    come from a pre-ADR-028 line without a markup, which keeps its stored price.
  const prices = lines.map((l) => {
    const cogs = (products.get(l.sku) as ProductRow).unit_cogs_cents
    return l.unit_markup_cents === null ? l.unit_price_cents : cyclePrice(cogs, l.unit_markup_cents)
  })
  let result
  try {
    result = split(
      lines.map<SplitLineInput>((l, i) => ({
        position: i + 1,
        qty: l.qty,
        unitPriceCents: prices[i],
        unitCogsCents: (products.get(l.sku) as ProductRow).unit_cogs_cents
      })),
      FEE_BPS
    )
  } catch (err) {
    if (err instanceof MoneyError && err.code === 'MARGIN_NEGATIVE') {
      return hold(trx, order, now, 'MARGIN_NEGATIVE')
    }
    throw err
  }

  // 3. Stock: a recurring sale has no reservation, so require available >= qty on hand
  //    (available = on_hand - reserved, never eating into reservations). EVAL-11b.
  for (const l of lines) {
    const product = products.get(l.sku) as ProductRow
    if (availableOf(product) < l.qty) {
      return hold(trx, order, now, 'INSUFFICIENT_STOCK')
    }
  }

  // 4. Charge the saved payment method for the SERVER-computed subtotal (rule 9).
  const amountCents = result.subtotal
  assertSafeInteger(amountCents)
  const idempotencyKey = `sched:${schedule.id}:cycle:${order.cycle_number}`
  const charge = await seams.paymentGateway.charge(amountCents, idempotencyKey, schedule.payment_method_token ?? undefined)
  if (charge.status === 'declined') {
    return hold(trx, order, now, 'PAYMENT_DECLINED')
  }

  // 5. Persist the derived snapshot on the lines (derived price + fresh COGS + allocation),
  //    so the paid cycle records exactly what it charged this run.
  const bySplitPos = new Map(result.lines.map((sl) => [sl.position, sl]))
  for (let i = 0; i < lines.length; i++) {
    const s = bySplitPos.get(i + 1)
    if (!s) throw new Error('internal: missing split line')
    await trx('order_lines').where({ id: lines[i].id }).update({
      unit_price_cents: prices[i],
      unit_cogs_cents: (products.get(lines[i].sku) as ProductRow).unit_cogs_cents,
      line_total_cents: s.total,
      line_cogs_cents: s.cogs,
      line_fee_cents: s.fee,
      line_margin_cents: s.margin
    })
  }

  // 6. Record the payment, sell stock, and POST THE JOURNAL VIA T4's function (money
  //    rule 8: one transaction, products locked above). No duplicate posting code.
  const [payment] = await trx('payments')
    .insert({
      order_id: order.id,
      idempotency_key: idempotencyKey,
      gateway_ref: charge.gatewayRef,
      amount_cents: amountCents,
      is_synthetic: order.is_synthetic
    })
    .returning<{ id: string }[]>('id')

  await sellOnHand(trx, order.id, lines)

  await postPaymentJournal(trx, {
    order: {
      id: order.id,
      providerId: order.provider_id,
      practiceId: order.practice_id,
      isSynthetic: order.is_synthetic
    },
    lines: result.lines.map((sl, i) => ({
      id: lines[i].id,
      lineTotalCents: sl.total,
      lineCogsCents: sl.cogs,
      lineFeeCents: sl.fee,
      lineMarginCents: sl.margin
    })),
    paymentId: payment.id
  })

  await trx('orders').where({ id: order.id }).update({
    status: 'paid',
    hold_reason: null,
    subtotal_cents: result.subtotal,
    cogs_cents: result.cogs,
    fee_cents: result.fee,
    margin_cents: result.margin,
    paid_at: now,
    updated_at: now
  })
  await trx('order_events').insert({
    order_id: order.id,
    from_status: order.status,
    to_status: 'paid',
    actor_user_id: null,
    note: 'recurring cycle charged'
  })

  return (await trx<CycleOrderRow>('orders').where({ id: order.id }).first()) as CycleOrderRow
}

/** Park the cycle on_hold with a reason; never leaves a payment, journal, or stock change. */
async function hold(
  trx: Knex.Transaction,
  order: CycleOrderRow,
  now: Date,
  reason: HoldReason
): Promise<CycleOrderRow> {
  await trx('orders').where({ id: order.id }).update({
    status: 'on_hold',
    hold_reason: reason,
    // Totals stay NULL while on_hold (no settled economics yet).
    subtotal_cents: null,
    cogs_cents: null,
    fee_cents: null,
    margin_cents: null,
    updated_at: now
  })
  await trx('order_events').insert({
    order_id: order.id,
    from_status: order.status,
    to_status: 'on_hold',
    actor_user_id: null,
    note: `on_hold: ${reason}`
  })
  return (await trx<CycleOrderRow>('orders').where({ id: order.id }).first()) as CycleOrderRow
}

/** Recurring sale: decrement on_hand by qty, reserved untouched (ARCHITECTURE section 6). */
async function sellOnHand(trx: Knex.Transaction, orderId: string, lines: OrderLineRow[]): Promise<void> {
  for (const line of lines) {
    await trx('products')
      .where({ sku: line.sku })
      .update({ on_hand_qty: trx.raw('on_hand_qty - ?', [line.qty]), updated_at: trx.fn.now() })
    await trx('inventory_movements').insert({
      sku: line.sku,
      delta_on_hand: -line.qty,
      delta_reserved: 0,
      reason: 'sale',
      order_id: orderId,
      actor_user_id: null
    })
  }
}

// ---- Patient token surface (NO X-Demo-User) ----

/** GET /api/pay/schedule/:token - patient-safe schedule view (strict whitelist). */
export async function getScheduleAuthorizeView(db: Knex, token: string): Promise<ScheduleAuthorizeView> {
  const schedule = await db<ScheduleRow>('recurring_schedules').where({ pay_token: token }).first()
  if (!schedule) throw notFound('No schedule for this link')
  const { items, perCycleTotalCents } = await patientLineView(db, schedule.id)
  const patient = await db('patients').where({ id: schedule.patient_id }).first()
  const firstName = ((patient?.name ?? '') as string).trim().split(/\s+/)[0] ?? ''
  return {
    patientFirstName: firstName,
    intervalDays: schedule.interval_days,
    items,
    perCycleTotalCents,
    authorized: schedule.authorized_at != null
  }
}

/** POST /api/pay/schedule/:token/authorize - authorize once; idempotent. */
export async function authorizeSchedule(
  db: Knex,
  token: string,
  seams: Seams = createSeams()
): Promise<ScheduleAuthorizeResult> {
  const now = seams.clock.now()
  return db.transaction(async (trx) => {
    const schedule = await trx<ScheduleRow>('recurring_schedules').where({ pay_token: token }).forUpdate().first()
    if (!schedule) throw notFound('No schedule for this link')
    if (schedule.status === 'cancelled') throw notActionable('This schedule is no longer active', { status: schedule.status })
    if (!schedule.authorized_at) {
      await trx('recurring_schedules').where({ id: schedule.id }).update({
        authorized_at: now,
        // Stubbed saved-payment-method token (FR-12 AC2). The gateway stub ignores it.
        payment_method_token: `pm_demo_${randomBytes(12).toString('base64url')}`
      })
    }
    return { authorized: true }
  })
}

// ---- Serializers ----

async function patientLineView(
  db: Knex,
  scheduleId: string
): Promise<{ items: ScheduleAuthorizeView['items']; perCycleTotalCents: number }> {
  const lines = await scheduleLinesPricedNow(db, scheduleId)
  const items = lines.map((l) => ({ name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents }))
  const perCycleTotalCents = lines.reduce((a, l) => a + l.qty * l.unitPriceCents, 0)
  return { items, perCycleTotalCents }
}

/**
 * The schedule's lines priced against TODAY's COGS + their markup (ADR-028): what the next
 * cycle would charge if COGS does not change before it runs.
 */
async function scheduleLinesPricedNow(
  db: Knex,
  scheduleId: string
): Promise<Array<ScheduleLineRow & { name: string; unitPriceCents: number }>> {
  const lines = await db<ScheduleLineRow>('schedule_lines').where({ schedule_id: scheduleId }).orderBy('position')
  const products = lines.length
    ? await db<ProductRow>('products').whereIn('sku', [...new Set(lines.map((l) => l.sku))]).select('sku', 'name', 'unit_cogs_cents')
    : []
  const bySku = new Map(products.map((p) => [p.sku, p]))
  return lines.map((l) => {
    const p = bySku.get(l.sku)
    return {
      ...l,
      name: p?.name ?? l.sku,
      unitPriceCents: p ? cyclePrice(p.unit_cogs_cents, l.unit_markup_cents) : l.unit_price_cents
    }
  })
}

function toCycleView(order: CycleOrderRow): ScheduleCycleView {
  return {
    orderId: order.id,
    cycleNumber: order.cycle_number ?? 0,
    status: order.status as ScheduleCycleView['status'],
    holdReason: (order.hold_reason as HoldReason | null) ?? null,
    subtotalCents: order.subtotal_cents,
    createdAt: new Date(order.created_at).toISOString()
  }
}

/** Build the full provider view for one schedule (lines + recent cycles). */
async function buildScheduleView(db: Knex, s: ScheduleRow): Promise<ScheduleView> {
  const lines = await scheduleLinesPricedNow(db, s.id)
  const cycleRows = await db<CycleOrderRow>('orders')
    .where({ schedule_id: s.id })
    .orderBy('cycle_number', 'desc')
  const perCycleSubtotalCents = lines.reduce((a, l) => a + l.qty * l.unitPriceCents, 0)
  return {
    id: s.id,
    patientId: s.patient_id,
    status: s.status as ScheduleView['status'],
    intervalDays: s.interval_days,
    nextRunAt: iso(s.next_run_at),
    authorized: s.authorized_at != null,
    authorizedAt: iso(s.authorized_at),
    payUrl: s.pay_token ? `/pay/schedule/${s.pay_token}` : '',
    perCycleSubtotalCents,
    lines: lines.map((l) => ({
      id: l.id,
      position: l.position,
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      unitPriceCents: l.unitPriceCents,
      unitMarkupCents: l.unit_markup_cents
    })),
    cycles: cycleRows.map(toCycleView),
    createdAt: new Date(s.created_at).toISOString()
  }
}

async function getScheduleView(db: Knex, id: string): Promise<ScheduleView> {
  const s = await db<ScheduleRow>('recurring_schedules').where({ id }).first()
  if (!s) throw notFound('No such schedule', { scheduleId: id })
  return buildScheduleView(db, s)
}
