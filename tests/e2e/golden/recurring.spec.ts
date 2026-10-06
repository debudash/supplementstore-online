// EVAL-11, 11b, 11c, 11d and RT-13: recurring schedules and cycles (FR-12, ADR-017),
// driven end to end over the real HTTP recurring routes (T9 merged):
//   provider  POST /api/schedules, POST /api/schedules/:id/run
//   patient   POST /api/pay/schedule/:token/authorize   (token route, no X-Demo-User)
// This suite is the INDEPENDENT check on T9. Expected cents/quantities are verbatim from
// docs/EVALS.md; a disagreement with T9 would be a real finding, not something to smooth
// over. ADR-017 is the point of the feature: a cost rise, stock gap, or missing auth
// SURFACES as an on_hold cycle with a reason, never a silent charge.
import { afterAll, beforeEach, describe, expect } from 'vitest'
import { anon, asUser, db, evalCase, resetState, PROV_ANA, PAT_CARA, SKU } from './_harness'

beforeEach(async () => {
  await resetState()
})
afterAll(async () => {
  await db.destroy()
})

interface SchedLine {
  sku: string
  qty: number
  unitPriceCents: number
}

/** Create a schedule for prov-ana / pat-cara; return its id and patient pay token. */
async function createSchedule(lines: SchedLine[]): Promise<{ id: string; token: string }> {
  const res = await asUser(PROV_ANA).post('/api/schedules').send({ patientId: PAT_CARA, lines })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const payUrl = res.body.payUrl as string // "/pay/schedule/<token>"
  const token = payUrl.split('/').pop() as string
  return { id: res.body.id as string, token }
}

/** Patient authorizes the schedule once through the token route. */
async function authorize(token: string) {
  const res = await anon.post(`/api/pay/schedule/${token}/authorize`).send({})
  expect(res.status).toBe(200)
  expect(res.body.authorized).toBe(true)
}

/** Provider "Run cycle now". */
async function runCycle(scheduleId: string) {
  return asUser(PROV_ANA).post(`/api/schedules/${scheduleId}/run`).send({})
}

const MAG_SCHEDULE: SchedLine[] = [{ sku: SKU.MAG, qty: 1, unitPriceCents: 2999 }]

describe('recurring (golden)', () => {
  evalCase('EVAL-11', 'authorized cycle pays: recurring_cycle, fee 22, margin 1527, MAG -1', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)

    const run = await runCycle(id)
    expect(run.status).toBe(200)
    expect(run.body.created).toBe(true)
    expect(run.body.cycle).toMatchObject({ cycleNumber: 1, status: 'paid', subtotalCents: 2999 })

    // The child order carries the locked-price / fresh-COGS split (EVAL-11 exact cents).
    const orderId = run.body.cycle.orderId as string
    const order = await db('orders').where({ id: orderId }).first()
    expect(order.kind).toBe('recurring_cycle')
    expect(order.status).toBe('paid')
    expect(order.subtotal_cents).toBe(2999)
    expect(order.cogs_cents).toBe(1450)
    expect(order.fee_cents).toBe(22)
    expect(order.margin_cents).toBe(1527)

    // Recurring sale: on_hand -1 (49), reserved untouched; one 'sale' movement of -1.
    const mag = await db('products').where({ sku: SKU.MAG }).first()
    expect(mag.on_hand_qty).toBe(49)
    expect(mag.reserved_qty).toBe(0)
    const sales = await db('inventory_movements').where({ order_id: orderId, reason: 'sale' })
    expect(sales).toHaveLength(1)
    expect(sales[0].delta_on_hand).toBe(-1)

    // Exactly one balanced PAYMENT journal, posted via T4's path (no duplicate posting).
    const journals = await db('journals').where({ order_id: orderId, type: 'PAYMENT' })
    expect(journals).toHaveLength(1)
    const entries = await db('ledger_entries').where({ journal_id: journals[0].id })
    const sumBy = (acct: string) => entries.filter((e) => e.account === acct).reduce((a, e) => a + e.amount_cents, 0)
    expect(sumBy('CASH_CLEARING')).toBe(2999)
    expect(sumBy('COGS_RECOVERY')).toBe(-1450)
    expect(sumBy('PROVIDER_PAYABLE')).toBe(-1527)
    expect(sumBy('PLATFORM_FEE_REVENUE')).toBe(-22)
    expect(entries.reduce((a, e) => a + e.amount_cents, 0)).toBe(0)
  })

  evalCase('EVAL-11b', 'insufficient stock -> cycle on_hold INSUFFICIENT_STOCK, no journal', async () => {
    const { id, token } = await createSchedule([{ sku: SKU.PROBIO, qty: 6, unitPriceCents: 4000 }])
    await authorize(token) // authorize first, so the hold reason is STOCK not AUTH
    const run = await runCycle(id)
    expect(run.status).toBe(200)
    expect(run.body.cycle).toMatchObject({ status: 'on_hold', holdReason: 'INSUFFICIENT_STOCK' })

    const orderId = run.body.cycle.orderId as string
    // No money moved: no payment, no journal; stock untouched (PROBIO still 5).
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect(await db('journals').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect((await db('products').where({ sku: SKU.PROBIO }).first()).on_hand_qty).toBe(5)
  })

  evalCase('EVAL-11c', 'unauthorized schedule run -> cycle on_hold NOT_AUTHORIZED, no journal', async () => {
    const { id } = await createSchedule(MAG_SCHEDULE) // deliberately NOT authorized
    const run = await runCycle(id)
    expect(run.status).toBe(200)
    expect(run.body.cycle).toMatchObject({ status: 'on_hold', holdReason: 'NOT_AUTHORIZED' })

    const orderId = run.body.cycle.orderId as string
    expect(await db('journals').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect((await db('products').where({ sku: SKU.MAG }).first()).on_hand_qty).toBe(50) // untouched
  })

  evalCase('EVAL-11d', 'COGS rise to 3000 -> cycle on_hold MARGIN_NEGATIVE (surfaced, not absorbed)', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)
    // Test helper: the catalog COGS rises above the locked price's margin headroom. The
    // cycle snapshots FRESH COGS, so the split now goes negative (ADR-006/017).
    await db('products').where({ sku: SKU.MAG }).update({ unit_cogs_cents: 3000 })

    const run = await runCycle(id)
    expect(run.status).toBe(200)
    expect(run.body.cycle).toMatchObject({ status: 'on_hold', holdReason: 'MARGIN_NEGATIVE' })

    const orderId = run.body.cycle.orderId as string
    // Nothing charged or sold; totals stay null while on_hold.
    expect(await db('journals').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect(await db('payments').where({ order_id: orderId }).then((r) => r.length)).toBe(0)
    expect((await db('products').where({ sku: SKU.MAG }).first()).on_hand_qty).toBe(50)
    const order = await db('orders').where({ id: orderId }).first()
    expect(order.margin_cents).toBeNull()
  })

  evalCase('RT-13', 'cycle triggered twice for the same period -> exactly ONE child order', async () => {
    const { id, token } = await createSchedule(MAG_SCHEDULE)
    await authorize(token)

    // Genuine concurrency: two "run now" requests race. RT-13 is enforced by a SELECT
    // ... FOR UPDATE row lock on the schedule PLUS a next_run_at due-gate (NOT a DB unique
    // constraint on (schedule_id, cycle_number) - the approved data model has none). The
    // first run claims the period and advances next_run_at; the second blocks on the lock,
    // then sees "not due" and no-ops.
    const [a, b] = await Promise.all([runCycle(id), runCycle(id)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    // Exactly one run created a cycle; the other was a no-op.
    expect([a.body.created, b.body.created].filter(Boolean)).toHaveLength(1)

    // Exactly ONE child order exists for this schedule, cycle_number 1, paid.
    const orders = await db('orders').where({ schedule_id: id })
    expect(orders).toHaveLength(1)
    expect(orders[0].cycle_number).toBe(1)
    expect(orders[0].status).toBe('paid')
    // Sold exactly once (MAG 49, not 48).
    expect((await db('products').where({ sku: SKU.MAG }).first()).on_hand_qty).toBe(49)
    expect(await db('journals').where({ order_id: orders[0].id, type: 'PAYMENT' }).then((r) => r.length)).toBe(1)
  })
})
